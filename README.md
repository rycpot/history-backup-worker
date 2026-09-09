# History Backup Worker

Cloudflare Worker backend for the **Full Browsing History** extension's
Cloud Backup feature. It proxies gzipped, one-day-at-a-time TSV exports of
your browsing history to a private R2 bucket in *your own* Cloudflare
account. Your history never touches any server but Cloudflare's — the
extension talks only to this Worker, and this Worker's source is public so
you can read exactly what it does before trusting it with your data.

## Deploy

Download this repo (or `git clone` it), then copy and paste each block
below into your terminal, in order, from inside that folder.

Commands are shown for **macOS/Linux/Git Bash**, with a **Windows
PowerShell** variant wherever the two differ.

### 1. Install Wrangler 
(you can skip this step if you have it already installed. Check by ```node -v``` and ```wrangler -v```)

```bash
npm install -g wrangler
```
if it gives an EACCES permission error then use this and enter the system/admin password as asked.
```bash
sudo npm install -g wrangler
```

Requires [Node.js](https://nodejs.org) (which includes npm) to already be
installed — same command on every OS.

### 2. Log in to Cloudflare

```bash
wrangler login
```

Opens a browser tab to authorize the CLI. Same on every OS.

### 3. Create the R2 bucket

```bash
wrangler r2 bucket create history-backup-data
```

Choose **R2 Object Storage** if the dashboard ever asks (not R2 Data
Catalog). Same on every OS.

### 4. Deploy the Worker

```bash
cd history-backup-worker
wrangler deploy
```

`cd` into whatever this folder is actually named on your machine — it may
be `history-backup-worker-main` if you used GitHub's "Download ZIP"
button rather than `git clone`.

Copy the printed Worker URL, e.g.
`https://history-backup-worker.YOUR-SUBDOMAIN.workers.dev`

### 5. Generate the backup token and upload it as a secret

**macOS / Linux / Git Bash:**

```bash
TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "$TOKEN"   # copy and save this now — you will not see it again
printf "%s" "$TOKEN" | wrangler secret put BACKUP_TOKEN
```

**Windows PowerShell:**

```powershell
$TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
Write-Output $TOKEN   # copy and save this now — you will not see it again
$TOKEN | wrangler secret put BACKUP_TOKEN
```

### 6. Paste both values into the extension

Settings → Cloud Backup → paste the Worker URL (step 4) and the token
(step 5) → click **Save**.

### 7. Verify with curl (optional)

**macOS / Linux / Git Bash:**

```bash
curl -H "Authorization: Bearer $TOKEN" "WORKER_URL/manifest"
```

**Windows PowerShell:**

```powershell
curl -H "Authorization: Bearer $TOKEN" "WORKER_URL/manifest"
```

Should return `{"dates":[],"owner":null}` on a fresh deploy. Replace
`WORKER_URL` with the URL from step 4 (no trailing slash).

### Screenshot of commands execution.
I already have Node.js installed. I also have Cloudflare connected. So the screenshot does not show those steps (1 and 2 from above).

<img width="1778" height="1648" alt="CleanShot 2026-09-07 at 17 44 48@2x" src="https://github.com/user-attachments/assets/a3e25500-f8dc-48da-b0eb-26613bfbf684" />


## What this Worker does

See the doc comment at the top of `src/worker.js` for the full endpoint
list. In short: `GET /manifest` lists what's backed up, `PUT /object/:date`
and `GET /object/:date` push/pull one day's gzipped history at a time, and
`/confirm-takeover` / `/unlink` manage which device is allowed to write
(one device owns the backup at a time; switching devices requires an
explicit takeover).
