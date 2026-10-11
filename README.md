# Revela (v1, no AI yet)

Instagram-style app: photos, reels, likes, comments, follow, profiles, search.

```
revela/
  backend/   Node + Express + SQLite API (zero database setup)
  mobile/    React Native (Expo) source: App.js + src/
```

## 1. Run the backend

Requires Node 22.13 or newer (SQLite is built into Node, so nothing needs compiling). You may see a harmless "SQLite is an experimental feature" warning.

```bash
cd backend
npm install
npm start
```

You should see `Revela API running on http://0.0.0.0:4000`.
Data is stored in `backend/data/` and uploads in `backend/uploads/` (both created automatically).

## 2. Create the mobile app

```bash
# from the revela/ folder
npx create-expo-app@latest app --template blank
cd app
npx expo install @react-navigation/native @react-navigation/native-stack @react-navigation/bottom-tabs @react-navigation/elements react-native-screens react-native-safe-area-context @react-native-async-storage/async-storage expo-image-picker expo-video expo-constants @expo/vector-icons
```

Copy `mobile/App.js` over `app/App.js`, and copy the `mobile/src` folder into `app/`.

## 3. Run it

```bash
npx expo start
```

Install **Expo Go** on your phone (iOS App Store / Google Play), make sure the phone is on the **same Wi-Fi** as your computer, and scan the QR code.
The app finds the backend automatically using your computer's IP. To set it manually:
`EXPO_PUBLIC_API_URL=http://192.168.x.x:4000 npx expo start`

## Test checklist

1. Sign up user 1 on your phone, then share a photo and a video from the + tab.
2. Sign up user 2 (second phone, or log out and sign up again).
3. Explore → search user 1 → Follow → their posts appear in Home.
4. Like, comment, open Reels (swipe up/down, tap to pause), edit profile and avatar, delete your own post.

## Troubleshooting

- "Can't reach the server": backend not running, different Wi-Fi, or firewall blocking port 4000 (on Windows allow Node.js through the firewall).
- Android emulator only: use `EXPO_PUBLIC_API_URL=http://10.0.2.2:4000`.
- Reset all data: stop the backend and delete `backend/data` and `backend/uploads`.

## API summary (all under /api, JWT bearer auth except register/login)

POST /auth/register, POST /auth/login, GET /auth/me, PUT /me,
GET /feed, GET /explore, GET /reels, POST /posts, GET|DELETE /posts/:id,
POST /posts/:id/like, GET|POST /posts/:id/comments,
GET /users/search?q=, GET /users/:username, GET /users/:username/posts, POST /users/:username/follow
