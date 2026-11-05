# Car photo uploads

## Setup
1. `cd backend && npm install`  (installs `multer`, the multipart/form-data middleware)
2. Add to `.env` (all optional; these are the defaults, see `.env.example`):
   ```
   PUBLIC_BASE_URL=http://localhost:5000   # how the BROWSER reaches this API; stored photo URLs start with it
   STORAGE_DRIVER=local
   UPLOAD_DIR=uploads                      # created automatically, ignored by git
   UPLOAD_MAX_FILE_SIZE_MB=5
   ```
3. Frontend `.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:5000/api`
4. `npm run dev`, then check everything with `npm run test:upload` (needs the API running and `npm run db:setup` done once).

## API (all need `Authorization: Bearer <token>` or the login cookie)
| Method and path | Who | What |
|---|---|---|
| `POST /api/partners/me/cars/:id/images` | partner who owns car `:id` | multipart field `image`. Stores the file and inserts a `car_images` row (`car_id`, `image_url`, next `sort_order`). `201 { image: { id, url, carId }, car }` |
| `POST /api/partners/me/car-images` | partner | Same upload for a car that is not saved yet (Add Car form). Returns `201 { image: { url } }`; the URL is saved to `car_images` when the car is created/updated. |
| `GET /uploads/cars/<partnerId>/<uuid>.<ext>` | public | The image itself (like any car photo on the public site) |

Rules: JPG, PNG or WebP only (checked by the file's real content, not its name or declared type), max 5 MB, one file per request, max 15 photos per car. Wrong type -> 400, too big -> 413, no token -> 401, customer/admin -> 403, someone else's car -> 404. A partner can only attach photos stored under their own folder (`cars/<their partner id>/`) to a car; removing a photo or deleting a car also deletes the file.
Admins have no car-editing rights in this API (only approve/reject/suspend), so they get no upload route.

## Moving to cloud storage later
Files are held in memory by Multer and handed to `src/services/storage`. Add a driver there (for example `s3.js`) exposing `save({ key, buffer })`, `keyFromUrl(url)` and `removeByUrl(url)`, register it in `index.js`, and set `STORAGE_DRIVER`. Routes, database and frontend stay the same, because the database only stores a URL.
