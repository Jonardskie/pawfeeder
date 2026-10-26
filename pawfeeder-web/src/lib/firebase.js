import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

// Fallback config so the app never crashes with a blank screen on Vercel
const firebaseConfig = {
  apiKey:      import.meta.env.VITE_FIREBASE_API_KEY      || 'AIzaSyDCkx1BM1ETuOVOtsRNZCHfla3Lu8Y2ZKE',
  authDomain:  import.meta.env.VITE_FIREBASE_AUTH_DOMAIN  || 'paw-feeder-faed3.firebaseapp.com',
  databaseURL: import.meta.env.VITE_FIREBASE_DB_URL      || 'https://paw-feeder-faed3-default-rtdb.firebaseio.com',
  projectId:   import.meta.env.VITE_FIREBASE_PROJECT_ID   || 'paw-feeder-faed3',
}

const app = initializeApp(firebaseConfig)
export const db = getDatabase(app)
