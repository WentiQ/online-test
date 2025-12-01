// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyCoGSmG8VKqP2qqKTD6YX2Uzn8m5-pvhoI",
  authDomain: "test-portal-5dba5.firebaseapp.com",
  projectId: "test-portal-5dba5",
  storageBucket: "test-portal-5dba5.firebasestorage.app",
  messagingSenderId: "49662298964",
  appId: "1:49662298964:web:4a752e46754fe6f783d6c1",
  measurementId: "G-E3RYN5SEEY"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// Export services so other files can use them
export const auth = getAuth(app);
export const db = getFirestore(app);
export const provider = new GoogleAuthProvider();