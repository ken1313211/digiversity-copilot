import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, get, update, onValue, remove, child, push, onChildAdded, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCyrI6Lq6bQbZ8RCsAxI46hFVRDrfRX_8M",
  authDomain: "copilot-game-f2556.firebaseapp.com",
  databaseURL: "https://copilot-game-f2556-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "copilot-game-f2556",
  storageBucket: "copilot-game-f2556.firebasestorage.app",
  messagingSenderId: "310183366254",
  appId: "1:310183366254:web:bacf07d827643bce0e207f",
  measurementId: "G-P8EF5X15QR"
};

let app, database, auth, storage;
let isFirebaseEnabled = false;
let currentUser = null;

try {
    if (Object.keys(firebaseConfig).length > 0) {
        app = initializeApp(firebaseConfig);
        database = getDatabase(app);
        auth = getAuth(app);
        storage = getStorage(app);
        isFirebaseEnabled = true;

        onAuthStateChanged(auth, (user) => {
            if (user && !user.isAnonymous) {
                currentUser = user;
                console.log("Logged in as Admin:", user.email);
            } else if (user && user.isAnonymous) {
                signOut(auth).catch(console.error);
                currentUser = null;
            } else {
                currentUser = null;
                console.log("Admin logged out.");
            }
        });

        console.log("Firebase initialized successfully.");
    } else {
        console.warn("Firebase config is empty. Live sync will not work.");
    }
} catch (error) {
    console.error("Firebase initialization error:", error);
}

export { database, auth, storage, ref, set, get, update, onValue, remove, child, push, onChildAdded, runTransaction, storageRef, uploadBytes, getDownloadURL, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, isFirebaseEnabled, onAuthStateChanged };
export const getCurrentUser = () => currentUser;