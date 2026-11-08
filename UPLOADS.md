# Car photo uploads (local storage) - production guide for Hostinger

Car photos are saved on the server's disk (`STORAGE_DRIVER=local`) and served by Express at
`https://api.capitalcarsharing.com/uploads/...`. The database stores only the URL (`car_images.image_url`).
Identity documents use a separate **private** folder that is never served.

## 1. Read this first: does Hostinger keep uploaded files?

Hostinger's Node.js docs say every deployment is built into a **new folder** (`hbuilds/versions/{build-id}`) and the
live app (`hbuilds/current`, a symlink) is switched to it. Server apps run from `~/domains/<domain>/hbuilds/current/nodejs`.
The docs do **not** say that files written at runtime survive a redeploy, and they describe no persistent upload storage.
So: **do not assume files saved inside the app folder survive a redeploy.**

What this setup does about it:
- `UPLOAD_DIR` is an absolute folder **outside** the deployed app, in your account's home folder
  (`~/capital-storage/uploads`). Nothing in a deployment writes there, so it should survive; Hostinger does not
  promise this in writing, so **prove it once** with the test in section 5.
- At startup the server prints the resolved folder and warns if it is inside the app / `hbuilds`.

If the test in section 5 fails (files disappear after a redeploy), local storage cannot work on that plan. Then
use one of these (tell me which and I will add it as a storage driver; routes, database and frontend stay the same):
1. **S3-compatible object storage** (Cloudflare R2, Backblaze B2, AWS S3) - best fit, small cost, survives everything.
2. **A Hostinger VPS** - a normal disk you control; local storage works as-is.

## 2. Environment variables (hPanel -> Websites -> your API app -> Deployments -> Deployment settings -> Environment variables)

| Variable | Value | Notes |
|---|---|---|
| `STORAGE_DRIVER` | `local` | Anything else (e.g. the old `cloudinary`) stops the app at startup with a clear message. |
| `PUBLIC_BASE_URL` | `https://api.capitalcarsharing.com` | https, no trailing slash. In production the app refuses `localhost`/`http`. |
| `UPLOAD_DIR` | `~/capital-storage/uploads` | `~` = your home folder (e.g. `/home/u123456789`). Or the full absolute path. |
| `VERIFICATION_STORAGE_DIR` | `~/capital-storage/private-uploads` | **Different** folder from `UPLOAD_DIR`. See section 6 before changing it. |
| `UPLOAD_MAX_FILE_SIZE_MB` | `5` | |
| `CORS_ORIGIN` | `https://www.capitalcarsharing.com,https://capitalcarsharing.com` | Your site is on `www`, so `www` must be listed. |
| `FRONTEND_URL` | `https://www.capitalcarsharing.com` | Used in password-reset emails. |
| `PORT` | **do not set** | Hostinger provides it; the code reads `process.env.PORT`. |
| `DATABASE_URL`, `JWT_SECRET`, `SMTP_*` | as today | Unchanged. |

Delete any `CLOUDINARY_*` variables from hPanel. A complete template is in `.env.production.example`.

### Create the folders (once)
Hostinger SSH (or File Manager, in your home folder, *not* inside `domains/`):
```bash
echo $HOME                                  # e.g. /home/u123456789  (this is what "~" means)
mkdir -p ~/capital-storage/uploads ~/capital-storage/private-uploads
chmod 755 ~/capital-storage ~/capital-storage/uploads
chmod 700 ~/capital-storage/private-uploads
```
The Node process runs as your account user, so it can write there. On start the log shows either
`Public uploads folder OK (writable): ...` or `!! Public uploads folder is NOT writable ...`.

## 3. Deploy and restart
1. Upload / push this version (it no longer contains `cloudinary` in `package.json`; `package-lock.json` is updated).
2. Deployments -> **Redeploy** (this runs `npm install`, which removes the unused package). Environment variable changes only apply after a redeploy/restart.
3. Open **Runtime logs** and confirm:
   - `PostgreSQL connected`
   - `Public uploads folder OK (writable): /home/<you>/capital-storage/uploads -> https://api.capitalcarsharing.com/uploads/`
   - `Capital Car Sharing API listening on port <n> (...)`
   - no line starting with `!!`
4. Check `https://api.capitalcarsharing.com/api/health` -> `{"success":true,...,"database":"connected"}`.

## 4. Fix photo URLs already saved with localhost (one time, safe)
Rows saved before `PUBLIC_BASE_URL` was fixed may hold `http://localhost:5000/uploads/...`. The repair only rewrites that text; it
never deletes rows or files and leaves external/placeholder images alone.
```bash
cd ~/domains/api.capitalcarsharing.com/hbuilds/current/nodejs   # or wherever the app is
npm run fix:image-urls            # dry run: prints what would change + files missing on disk
npm run fix:image-urls -- --apply # rewrites the URLs
```
(In an SSH session the hPanel variables are not loaded: keep `.env` in the app folder, or `export DATABASE_URL JWT_SECRET PUBLIC_BASE_URL UPLOAD_DIR` first.)
Photos that were uploaded on your own computer are not on the server, so those URLs will 404 until uploaded again
(the dry run lists them). Old Cloudinary URLs already in the database are left as they are; they keep working only
while that Cloudinary account/files exist.

## 5. Test with Postman (and prove persistence)
1. Postman -> Import -> `postman/capital-car-sharing-uploads.postman_collection.json`.
2. Collection -> Variables: set `partnerEmail`, `partnerPassword`, `carId` (a car that partner owns). `baseUrl` is already `https://api.capitalcarsharing.com`.
3. Run **1. Partner login**, then **2. Upload image BEFORE the car exists**: Body -> form-data -> key `image` (type **File**) -> pick a JPG/PNG/WebP under 5 MB. Expected `201`:
   ```json
   { "success": true, "data": { "image": { "url": "https://api.capitalcarsharing.com/uploads/cars/1/0b7e...-....jpg" } } }
   ```
4. **3. Open the uploaded image** -> `200`, `Content-Type: image/jpeg`. Also paste the URL into a browser tab: the picture shows.
5. **4. Upload image to an existing car** -> `201` with `image: { id, url, carId }` and the full `car`. **5.** shows it in `car.images` (from PostgreSQL). **6.** removes it (PUT with the other URLs); **7.** now returns `404`.
6. Same thing with cURL:
   ```bash
   TOKEN=$(curl -s -X POST https://api.capitalcarsharing.com/api/auth/partner/login -H 'Content-Type: application/json' \
     -d '{"email":"you@example.com","password":"..."}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')
   curl -i -X POST https://api.capitalcarsharing.com/api/partners/me/car-images -H "Authorization: Bearer $TOKEN" -F "image=@photo.jpg"
   ```
7. **Persistence test (important):** upload one photo, **redeploy the app from hPanel**, then open the photo URL again.
   Still `200` -> local storage is safe on your plan. `404` -> read section 1 (object storage or VPS).

## 6. NODE_ENV and the encryption key (do not skip)
`NODE_ENV` is `development` in the `.env` you sent. With `development`, identity-document numbers are encrypted with a key
derived from `JWT_SECRET`. If you set `NODE_ENV=production`, `VERIFICATION_ENCRYPTION_KEY` becomes mandatory, and a **different** key
would make document numbers that are already saved unreadable. So either keep `NODE_ENV` as it is, or set it to production **together with**
`VERIFICATION_ENCRYPTION_KEY=<output of the command below>` (this reproduces the current derived key):
```bash
node -e "console.log(require('crypto').createHash('sha256').update('verification-field-key:'+process.env.JWT_SECRET).digest('hex'))"
```
(run it with your real `JWT_SECRET` in the environment). Only use a fresh random key if no verification has ever been submitted.

Moving the private identity-document folder: stop uploads, **copy** the existing `private-uploads` folder (the one inside the app) to
`~/capital-storage/private-uploads`, set `VERIFICATION_STORAGE_DIR`, redeploy, confirm a document still opens in the admin screen, then delete the old copy.
The app refuses to start if the private folder is the same as, inside, or above the public upload folder.

## 7. API reference (unchanged)
| Method and path | Who | What |
|---|---|---|
| `POST /api/partners/me/cars/:id/images` | partner who owns car `:id` | multipart field `image`. Stores the file, inserts a `car_images` row. `201 { image: { id, url, carId }, car }` |
| `POST /api/partners/me/car-images` | partner | Same upload for a car that is not saved yet (Add Car form). `201 { image: { url } }` |
| `PUT /api/partners/me/cars/:id` with `images: [...]` | owner | Replaces the photo list; photos left out are deleted from disk. |
| `GET /uploads/cars/<partnerId>/<uuid>.<ext>` | public | The image itself. |

Rules: JPG, PNG or WebP only (checked by the real file content), max 5 MB, one file per request, max 15 photos per car.
Wrong type -> 400, too big -> 413, no token -> 401, customer/admin -> 403, someone else's car -> 404.
A partner can only attach photos stored under their own `cars/<their partner id>/` folder.

## 8. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| App won't start, log says `Unknown STORAGE_DRIVER` | `STORAGE_DRIVER` is not `local` (old `cloudinary` value still in hPanel or `.env`). |
| App won't start, log says `PUBLIC_BASE_URL ...` | Value is localhost / http / not a URL. Use `https://api.capitalcarsharing.com`. |
| `500 Image storage is not available` | `UPLOAD_DIR` not writable. Read the `!!` line at startup; create the folder (section 2). |
| Photo uploads but URL 404s | The file is not in `UPLOAD_DIR` (lost on redeploy / uploaded elsewhere). See sections 1 and 5. |
| Browser blocks the request from the site | `CORS_ORIGIN` is missing `https://www.capitalcarsharing.com`. |
| Many users get `429 Too many requests` | Reverse proxy not trusted. Fixed in `app.js` (`trust proxy`); redeploy. |

## 9. Secrets
The zip contained `.env` with live credentials and the old Cloudinary API secret, and `.env copy` is tracked in git. Rotate the
Cloudinary API secret (or delete the Cloudinary key), consider rotating the database password, JWT secret and SMTP app password, and run
`git rm --cached ".env copy"`. `.gitignore` now ignores `.env.*` / `.env *` (except the `.example` files).
