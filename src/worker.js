/**
 * Full Browsing History with Cloud Backup — Cloud Backup Worker
 *
 * Deploy this to your own Cloudflare account. The extension's Settings >
 * Cloud Backup points at this Worker's URL and a bearer token you set below
 * -- the extension never talks to R2 directly, and no R2 API key/secret
 * ever leaves Cloudflare's edge. This Worker only ever moves a handful of
 * KB per request (one gzipped day-of-history TSV at a time), so it proxies
 * object bytes straight through itself via the native R2 binding rather
 * than minting presigned S3-style URLs -- that avoids needing a separate
 * R2 API token (Access Key ID/Secret) purely for signing, which presigned
 * URLs would otherwise require.
 *
 * Endpoints (all require `Authorization: Bearer <BACKUP_TOKEN>` except
 * OPTIONS preflights):
 *
 *   GET  /manifest
 *       -> { dates: [{ date, etag, size }, ...], owner: {deviceId, lastSyncTime} | null }
 *
 *   GET  /bucket-size
 *       -> { totalBytes, objectCount }
 *       True total across every object in the bucket (dates/ + meta/),
 *       read fresh from R2 on every call via list() -- not derived from
 *       /manifest's per-date sizes, so it stays correct even if something
 *       other than this Worker's own known keys ever ends up in the bucket.
 *
 *   GET  /object/:date
 *       -> raw gzip bytes (Content-Encoding: gzip), or 404 if that date
 *          hasn't been backed up. No device check -- reads are never
 *          gated, so a brand-new device can always pull the full history
 *          down before it has to resolve anything about write ownership.
 *
 *   PUT  /object/:date
 *       body: raw gzip bytes, header `X-Device-Id: <uuid>`
 *       -> { etag } on success.
 *       -> 409 { error: 'device_mismatch', currentDevice, lastSyncTime }
 *          if a *different* device currently owns this bucket. The first
 *          device ever to write claims ownership automatically; every
 *          write after that must come from the same device_id.
 *          meta/owner.json is only rewritten when ownership changes or
 *          lastSyncTime is more than OWNER_WRITE_THROTTLE_MS stale, not on
 *          every single date -- so lastSyncTime reflects "last write within
 *          the throttle window", not the literal most recent PUT.
 *
 *   POST /confirm-takeover   body: { deviceId }
 *       -> forcibly re-points ownership at `deviceId`, keeping a short
 *          history of previous owners. This is the explicit, deliberate
 *          "yes, replace the old device" action -- never automatic.
 *
 *   POST /unlink   body: { deviceId }
 *       -> clears ownership, but only if `deviceId` is the current owner
 *          (a device can only unlink itself, not force-unlink another
 *          device -- that's what confirm-takeover is for).
 *
 * R2 layout:
 *   dates/YYYY-MM-DD.tsv.gz   one gzipped TSV per local calendar date
 *   meta/owner.json           { deviceId, lastSyncTime, previous: [...] }
 */

const OBJECT_PREFIX = 'dates/';
const OWNER_KEY = 'meta/owner.json';
const MAX_PREVIOUS_OWNERS = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// How stale meta/owner.json's lastSyncTime is allowed to get before a PUT
// bothers rewriting it. See handlePutObject.
const OWNER_WRITE_THROTTLE_MS = 60 * 1000;

export default {
    async fetch(request, env) {
        try {
            if (request.method === 'OPTIONS') {
                return corsResponse(new Response(null, { status: 204 }));
            }

            const auth = request.headers.get('Authorization') || '';
            if (auth !== `Bearer ${env.BACKUP_TOKEN}`) {
                return corsResponse(jsonResponse({ error: 'unauthorized' }, 401));
            }

            const url = new URL(request.url);
            const parts = url.pathname.split('/').filter(Boolean);   // ['manifest'] or ['object', '2026-01-05']

            if (request.method === 'GET' && parts[0] === 'manifest') {
                return corsResponse(await handleManifest(env));
            }
            if (request.method === 'GET' && parts[0] === 'bucket-size') {
                return corsResponse(await handleBucketSize(env));
            }
            if (parts[0] === 'object' && parts.length === 2) {
                const date = parts[1];
                if (!DATE_RE.test(date)) {
                    return corsResponse(jsonResponse({ error: 'invalid_date' }, 400));
                }
                if (request.method === 'GET') {
                    return corsResponse(await handleGetObject(env, date));
                }
                if (request.method === 'PUT') {
                    return corsResponse(await handlePutObject(env, date, request));
                }
            }
            if (request.method === 'POST' && parts[0] === 'confirm-takeover') {
                return corsResponse(await handleConfirmTakeover(env, request));
            }
            if (request.method === 'POST' && parts[0] === 'unlink') {
                return corsResponse(await handleUnlink(env, request));
            }

            return corsResponse(jsonResponse({ error: 'not_found' }, 404));
        }
        catch (err) {
            return corsResponse(jsonResponse({ error: 'internal_error', message: String(err && err.message || err) }, 500));
        }
    }
};


async function handleManifest(env) {
    const dates = [];
    let cursor;
    do {
        // R2 list() pages at up to 1000 keys per call; loop until the
        // listing reports it's done rather than assuming one page is
        // everything -- matters once someone has years of daily history.
        const page = await env.BUCKET.list({ prefix: OBJECT_PREFIX, cursor });
        for (const obj of page.objects) {
            const date = obj.key.slice(OBJECT_PREFIX.length).replace(/\.tsv\.gz$/, '');
            dates.push({ date, etag: obj.httpEtag, size: obj.size });
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    const owner = await readOwner(env);
    return jsonResponse({ dates, owner });
}


async function handleBucketSize(env) {
    let totalBytes = 0;
    let objectCount = 0;
    let cursor;
    do {
        // No `prefix` here (unlike handleManifest's dates/-scoped listing)
        // -- this deliberately covers the whole bucket, including
        // meta/owner.json, so it reflects what R2/the dashboard would
        // actually report as "storage used", not just the backed-up dates.
        const page = await env.BUCKET.list({ cursor });
        for (const obj of page.objects) {
            totalBytes += obj.size;
            objectCount++;
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return jsonResponse({ totalBytes, objectCount });
}


async function handleGetObject(env, date) {
    const obj = await env.BUCKET.get(objectKey(date));
    if (!obj) {
        return jsonResponse({ error: 'not_found' }, 404);
    }
    const headers = new Headers();
    headers.set('Content-Type', 'application/gzip');
    headers.set('Content-Encoding', 'identity');   // the bytes ARE the gzip file; don't let a client auto-decompress on us.
    headers.set('ETag', obj.httpEtag);
    return new Response(obj.body, { headers });
}


async function handlePutObject(env, date, request) {
    const deviceId = request.headers.get('X-Device-Id') || '';
    if (!deviceId) {
        return jsonResponse({ error: 'missing_device_id' }, 400);
    }

    // readOwner (an R2 GET) and request.arrayBuffer() (draining the request
    // body) don't depend on each other, so run them concurrently instead of
    // paying both round-trips/reads in series -- saves one full R2 GET's
    // worth of latency on every single PUT.
    const [owner, body] = await Promise.all([
        readOwner(env),
        request.arrayBuffer()
    ]);
    if (owner && owner.deviceId && owner.deviceId !== deviceId) {
        return jsonResponse({
            error: 'device_mismatch',
            currentDevice: owner.deviceId,
            lastSyncTime: owner.lastSyncTime
        }, 409);
    }

    const put = await env.BUCKET.put(objectKey(date), body, {
        httpMetadata: { contentType: 'application/gzip' }
    });

    // meta/owner.json only needs a write when ownership is actually
    // changing (first-ever claim) or when lastSyncTime has gone stale by
    // more than OWNER_WRITE_THROTTLE_MS -- rewriting it on every single
    // date PUT (a full History Backup can mean thousands of them) costs an
    // extra R2 write per date for no correctness benefit, since the
    // device_mismatch check above only cares about deviceId, not exactly
    // how fresh lastSyncTime is. This makes lastSyncTime "last write within
    // the throttle window" rather than "the literal last write", which is
    // the intentional trade-off.
    const now = Date.now();
    const ownerIsStale = !owner || !owner.deviceId || owner.lastSyncTime == null
        || (now - owner.lastSyncTime) >= OWNER_WRITE_THROTTLE_MS;
    if (ownerIsStale) {
        await writeOwner(env, {
            deviceId,
            lastSyncTime: now,
            previous: owner ? owner.previous : []
        });
    }

    return jsonResponse({ etag: put.httpEtag });
}


async function handleConfirmTakeover(env, request) {
    const { deviceId } = await safeJson(request);
    if (!deviceId) {
        return jsonResponse({ error: 'missing_device_id' }, 400);
    }

    const owner = await readOwner(env);
    const previous = owner && owner.deviceId && owner.deviceId !== deviceId
        ? [{ deviceId: owner.deviceId, lastSyncTime: owner.lastSyncTime }, ...(owner.previous || [])].slice(0, MAX_PREVIOUS_OWNERS)
        : (owner ? owner.previous : []);

    // lastSyncTime is intentionally null here (not Date.now()) -- ownership
    // has been claimed, but nothing has actually been written by this
    // device yet. The first successful PUT sets the real timestamp.
    await writeOwner(env, { deviceId, lastSyncTime: null, previous });

    return jsonResponse({ ok: true, owner: await readOwner(env) });
}


async function handleUnlink(env, request) {
    const { deviceId } = await safeJson(request);
    const owner = await readOwner(env);

    if (!owner) {
        return jsonResponse({ ok: true });   // already unowned; nothing to do.
    }
    if (owner.deviceId !== deviceId) {
        // Deliberately narrow: a device can only unlink itself. Forcibly
        // detaching a *different* device's claim is what confirm-takeover
        // is for, which is a distinct, explicit user action on purpose.
        return jsonResponse({ error: 'not_owner', currentDevice: owner.deviceId }, 409);
    }

    await env.BUCKET.delete(OWNER_KEY);
    return jsonResponse({ ok: true });
}


function objectKey(date) {
    return `${OBJECT_PREFIX}${date}.tsv.gz`;
}

async function readOwner(env) {
    const obj = await env.BUCKET.get(OWNER_KEY);
    if (!obj) {
        return null;
    }
    try {
        return await obj.json();
    }
    catch {
        return null;   // corrupt/empty meta object -- treat as unowned rather than hard-fail every request.
    }
}

async function writeOwner(env, owner) {
    await env.BUCKET.put(OWNER_KEY, JSON.stringify(owner), {
        httpMetadata: { contentType: 'application/json' }
    });
}

async function safeJson(request) {
    try {
        return await request.json();
    }
    catch {
        return {};
    }
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

// The extension calls this Worker from a chrome-extension:// origin, which
// is effectively cross-origin. `Access-Control-Allow-Origin: *` is fine
// here because access is already gated by the bearer token check above --
// CORS is only relaxing *which page scripts* may read the response, not
// who can authenticate.
function corsResponse(response) {
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, X-Device-Id, Content-Type');
    return new Response(response.body, { status: response.status, headers });
}
