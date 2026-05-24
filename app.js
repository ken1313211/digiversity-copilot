import {
    database, auth, ref, set, get, update, onValue, remove, child, push, onChildAdded, runTransaction,
    signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, isFirebaseEnabled, getCurrentUser, onAuthStateChanged
} from "./firebase-config.js";

// ==========================================
// 1. COPILOT BRANDED PRESETS & CONFIG
// ==========================================
const defaultPresets = [
    {
        title: "Microsoft Copilot Basics",
        questions: [
            { type: "multiple-choice", text: "What is Copilot's main purpose?", options: ["Create spreadsheets", "Act as an everyday AI companion", "Replace human jobs", "Write security policies"], correct: 1, timeLimit: 20 },
            { type: "multiple-choice", text: "Which underlying model powers Microsoft Copilot?", options: ["BERT", "Llama 3", "OpenAI GPT-4", "Gemini"], correct: 2, timeLimit: 20 },
            { type: "true-false", text: "Copilot uses your enterprise data to train public models.", options: ["True", "False"], correct: 1, timeLimit: 15 },
            { type: "jumbled-prompt", text: "Order this prompt to summarize a document:", words: ["Summarize", "this document", "into 3", "bullet points"], timeLimit: 30 }
        ]
    },
    {
        title: "Prompt Engineering 101",
        questions: [
            { type: "multiple-choice", text: "Which framework is best for writing a prompt?", options: ["Goal, Context, Source, Format", "Fast, Cheap, Good", "Who, What, Where", "Code, Fix, Run"], correct: 0, timeLimit: 20 },
            { type: "true-false", text: "A prompt should ideally be vague to test the AI's capabilities.", options: ["True", "False"], correct: 1, timeLimit: 15 },
            { type: "multiple-choice", text: "What is a 'Hallucination'?", options: ["When Copilot crashes", "When the AI generates a confident but incorrect response", "A cool graphic effect", "A security breach"], correct: 1, timeLimit: 20 },
            { type: "jumbled-prompt", text: "Order this prompt for drafting an email:", words: ["Draft an email", "to the team", "announcing", "the new project"], timeLimit: 30 }
        ]
    }
];

let copilotPresets = [];
try {
    const saved = localStorage.getItem("copilot_custom_quizzes");
    if (saved) {
        copilotPresets = JSON.parse(saved);
    } else {
        copilotPresets = defaultPresets;
        localStorage.setItem("copilot_custom_quizzes", JSON.stringify(copilotPresets));
    }
} catch (e) {
    copilotPresets = defaultPresets;
}

const THEME_COLORS = {
    primary: "#00E6F2",
    purple: "#8764B8",
    blue: "#0F6CBD",
    darkBlue: "#0A2E5C"
};

// Global State
let editingQuizIndex = null;
let gameSessionRef = null;
let currentSessionPin = null;
let currentRole = null;
let myPlayerKey = null;
let myNickname = "";
let currentQuizData = null;

// Host tracking configurations
let timerInterval = null;
let timeLeft = 0;
let hostActiveQuestionIndex = 0;
let hostAnswersMap = {};
let isTimerPaused = false;
let sessionTotalAnswersCount = 0;
let sessionTotalCorrectAnswersCount = 0;

// Player data tracking
let hasAnsweredCurrent = false;
let currentQuestionStartTime = 0;
let currentScore = 0;
let currentStreak = 0;
let previousRank = null;

// Synchronization handles
let sessionStateListener = null;
let playerLobbyListener = null;
let answersListener = null;
let emojiListener = null;
let emojiCooldownActive = false;

const views = {
    landing: document.getElementById("view-landing"),
    adminLogin: document.getElementById("view-admin-login"),
    playerJoin: document.getElementById("view-player-join"),
    playerLobby: document.getElementById("view-player-lobby"),
    playerQuestion: document.getElementById("view-player-question"),
    playerResult: document.getElementById("view-player-result"),
    playerLeaderboard: document.getElementById("view-player-leaderboard"),
    hostSetup: document.getElementById("view-host-setup"),
    adminMaker: document.getElementById("view-admin-maker"),
    hostLobby: document.getElementById("view-host-lobby"),
    hostQuestion: document.getElementById("view-host-question"),
    hostResults: document.getElementById("view-host-results"),
    hostLeaderboard: document.getElementById("view-host-leaderboard")
};

const sfx = {
    tick: document.getElementById("sfx-tick"),
    ding: document.getElementById("sfx-ding"),
    powerup: document.getElementById("sfx-powerup")
};

// ==========================================
// 2. VIEW NAVIGATION SYSTEM
// ==========================================
function switchView(targetKey) {
    Object.keys(views).forEach(key => {
        if (views[key]) views[key].classList.remove("active");
    });
    if (views[targetKey]) {
        views[targetKey].classList.add("active");
        console.log(`Switched layout to view state: ${targetKey}`);
    } else {
        console.error(`Target view layout mapping failed for: ${targetKey}`);
    }
}

function purgeActiveListeners() {
    if (sessionStateListener) { sessionStateListener(); sessionStateListener = null; }
    if (playerLobbyListener) { playerLobbyListener(); playerLobbyListener = null; }
    if (answersListener) { answersListener(); answersListener = null; }
    if (emojiListener) { emojiListener(); emojiListener = null; }
}

// ==========================================
// 3. CORE INITIALIZATION PIPELINE
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    console.log("CopilotQuiz operational system running successfully...");

    if (!isFirebaseEnabled) {
        const warningModal = document.getElementById("firebase-warning-modal");
        if (warningModal) warningModal.classList.remove("hidden");
        document.getElementById("btn-dismiss-firebase")?.addEventListener("click", () => {
            warningModal.classList.add("hidden");
        });
    }

    // Attach Interactivity Routes
    document.getElementById("btn-goto-join")?.addEventListener("click", () => switchView("playerJoin"));
    document.getElementById("btn-goto-login")?.addEventListener("click", () => {
        if (getCurrentUser()) {
            enterHostDashboard();
        } else {
            switchView("adminLogin");
        }
    });

    document.getElementById("btn-back-landing-login")?.addEventListener("click", () => switchView("landing"));
    document.getElementById("btn-back-landing-player")?.addEventListener("click", () => switchView("landing"));
    document.getElementById("btn-back-landing-host")?.addEventListener("click", () => {
        switchView("landing");
    });

    setupAdminAuthWorkflow();
    setupHostManagementWorkflow();
    setupPlayerParticipationWorkflow();
});

// ==========================================
// 4. ADMINISTRATIVE WORKFLOW SYSTEMS
// ==========================================
function setupAdminAuthWorkflow() {
    if (isFirebaseEnabled) {
        onAuthStateChanged(auth, (user) => {
            if (user && !user.isAnonymous) {
                // Only auto-redirect to host setup if they are explicitly viewing the admin login page
                if (views.adminLogin.classList.contains("active")) {
                    enterHostDashboard();
                }
            }
        });
    }

    const loginForm = document.getElementById("form-admin-login");
    loginForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const pwdInput = document.getElementById("input-admin-password");
        const submitBtn = document.getElementById("btn-admin-login");

        if (!isFirebaseEnabled) {
            if (pwdInput.value === "eycopilot2026") {
                pwdInput.value = "";
                enterHostDashboard();
            } else {
                alert("Administrative connection verification credentials failed.");
            }
            return;
        }

        const password = pwdInput.value;

        try {
            submitBtn.disabled = true;
            await signInWithEmailAndPassword(auth, "admin-digiversity@copilotquiz.internal", password);
            pwdInput.value = "";
            enterHostDashboard();
        } catch (err) {
            console.warn("Sign-in failed. Attempting auto-registration of admin account...", err);
            // If user doesn't exist, we register the account automatically
            if (err.code === "auth/user-not-found" || err.code === "auth/invalid-credential" || err.code === "auth/wrong-password") {
                try {
                    await createUserWithEmailAndPassword(auth, "admin-digiversity@copilotquiz.internal", password);
                    pwdInput.value = "";
                    enterHostDashboard();
                    return;
                } catch (createErr) {
                    console.error("Auto-registration of admin account failed:", createErr);
                }
            }
            alert("Administrative connection verification credentials failed.");
        } finally {
            submitBtn.disabled = false;
        }
    });

    document.getElementById("btn-admin-logout")?.addEventListener("click", async () => {
        purgeActiveListeners();
        if (isFirebaseEnabled) await signOut(auth);
        switchView("landing");
    });
}

// ============================================
// QUESTION MAKER - PREMIUM BUILDER SYSTEM
// ============================================
const GAME_TYPE_META = {
    "multiple-choice": { label: "Knowledge Check", icon: "🔠", color: "#0F6CBD" },
    "true-false":      { label: "Fact or Hallucination", icon: "✅", color: "#8764B8" },
    "jumbled-prompt":  { label: "Prompt Assembly", icon: "🔀", color: "#00E6F2" },
    "type-answer":     { label: "Exact Output", icon: "⌨️", color: "#a855f7" },
    "number-guess":    { label: "Token Estimator", icon: "🎯", color: "#f97316" },
    "poll":            { label: "Usage Poll", icon: "📊", color: "#22c55e" },
    "speed-math":      { label: "Logic Processing", icon: "⚡", color: "#FFD700" },
};

const SAMPLE_DATA = {
    "multiple-choice": [
        { text: "Which Copilot feature helps you summarize a long Teams meeting?", options: ["Copilot in Word", "Intelligent Recap", "Excel Formula Builder", "Outlook Catch Up"], correct: 1 },
        { text: "What is the primary LLM architecture powering Microsoft Copilot?", options: ["BERT", "GPT-4", "Claude", "Llama 3"], correct: 1 }
    ],
    "true-false": [
        { text: "Copilot can browse your private OneDrive files without your permission." },
        { text: "Copilot in PowerPoint can generate a slide deck from a Word document." }
    ],
    "jumbled-prompt": [
        { text: "Order this prompt to summarize a document effectively:", words: ["Summarize", "this document", "into 3", "bullet points"] },
        { text: "Order this prompt to draft a professional email:", words: ["Draft a", "professional email", "announcing", "the launch"] }
    ],
    "type-answer": [
        { text: "Which Microsoft app uses Copilot to help you write formulas?", answerText: "Excel" },
        { text: "What is the acronym for Large Language Model?", answerText: "LLM" }
    ],
    "number-guess": [
        { text: "How many tokens does the word 'hamburger' typically consume?", targetNumber: 3 },
        { text: "If an API call takes 200ms, how many can you make in one second?", targetNumber: 5 }
    ],
    "poll": [
        { text: "Which Copilot feature do you use the most?", options: ["Email Drafting", "Code Generation", "Meeting Recaps", "Data Analysis"] },
        { text: "How confident are you in writing advanced prompts?", options: ["Very Confident", "Somewhat Confident", "Neutral", "Need Training"] }
    ],
    "speed-math": [
        { text: "Process this logic: 1024 tokens ÷ 4 tokens per word =", equation: "1024 ÷ 4", answerNumber: 256 },
        { text: "Calculate the latency: 50ms x 4 requests =", equation: "50 x 4", answerNumber: 200 }
    ]
};

function updateMakerCount() {
    const count = document.querySelectorAll(".maker-q-block").length;
    const el = document.getElementById("maker-q-count");
    if (el) el.innerText = count === 0 ? "0 questions added" : `${count} question${count !== 1 ? "s" : ""} added`;
    const emptyState = document.getElementById("maker-empty-state");
    if (emptyState) emptyState.style.display = count === 0 ? "flex" : "none";
}

function buildMakerBlock(typeSelect) {
    const meta = GAME_TYPE_META[typeSelect] || { label: typeSelect, icon: "❓", color: "white" };
    const qBlock = document.createElement("div");
    qBlock.className = "maker-q-block fade-in-up";
    qBlock.setAttribute("data-qtype", typeSelect);
    const radioGroup = "mc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);

    let html = `
        <div class="maker-q-header" style="border-left: 4px solid ${meta.color}">
            <span style="display:flex;align-items:center;gap:0.6rem">
                <span style="font-size:1.4rem">${meta.icon}</span>
                <strong style="color:${meta.color};font-size:1rem">${meta.label}</strong>
            </span>
            <div style="display:flex; gap:0.5rem">
                <button class="btn btn-secondary maker-up-btn" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; border-radius: var(--radius-sm); cursor: pointer;" title="Move Up">↑</button>
                <button class="btn btn-secondary maker-down-btn" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; border-radius: var(--radius-sm); cursor: pointer;" title="Move Down">↓</button>
                <button class="btn btn-secondary maker-sample-btn" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; border-radius: var(--radius-sm); cursor: pointer;" title="Generate Sample Data">🎲</button>
                <button class="btn btn-secondary maker-preview-btn" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; border-radius: var(--radius-sm); cursor: pointer;">👁️ Preview</button>
                <button class="maker-remove-btn">✕ Remove</button>
            </div>
        </div>
        <div class="maker-q-field">
            <label class="maker-q-label">Question Text</label>
            <textarea class="maker-q-text" rows="2" placeholder="Write your question here..."></textarea>
        </div>`;

    if (typeSelect === "multiple-choice") {
        html += `
            <div class="maker-options-grid">
                <div class="maker-q-field maker-opt-row"><input type="radio" name="${radioGroup}" class="maker-q-correct" value="0" checked><input type="text" class="maker-q-opt" placeholder="Option A..."></div>
                <div class="maker-q-field maker-opt-row"><input type="radio" name="${radioGroup}" class="maker-q-correct" value="1"><input type="text" class="maker-q-opt" placeholder="Option B..."></div>
                <div class="maker-q-field maker-opt-row"><input type="radio" name="${radioGroup}" class="maker-q-correct" value="2"><input type="text" class="maker-q-opt" placeholder="Option C... (optional)"></div>
                <div class="maker-q-field maker-opt-row"><input type="radio" name="${radioGroup}" class="maker-q-correct" value="3"><input type="text" class="maker-q-opt" placeholder="Option D... (optional)"></div>
            </div>
            <div class="maker-q-hint">🔘 Select the radio button next to the <strong style="color:#22c55e">correct answer</strong>.</div>`;
    } else if (typeSelect === "true-false") {
        html += `
            <div class="maker-q-guide" style="background: rgba(255,255,255,0.05); border-left: 3px solid #8764B8; padding: 0.75rem; margin-bottom: 1rem; border-radius: 0 4px 4px 0; font-size: 0.85rem; color: #cbd5e1;">
                <strong>💡 How it works:</strong> Players see "True" and "False" buttons. Write the scenario so that "True" is always the correct factual answer.
            </div>`;
    } else if (typeSelect === "jumbled-prompt") {
        html += `
            <div class="maker-q-guide" style="background: rgba(255,255,255,0.05); border-left: 3px solid #00E6F2; padding: 0.75rem; margin-bottom: 1rem; border-radius: 0 4px 4px 0; font-size: 0.85rem; color: #cbd5e1;">
                <strong>💡 How it works:</strong> Players must tap fragments to build the correct prompt order. Enter the fragments below in the <strong>correct order</strong> separated by commas (the game scrambles them automatically).
            </div>
            <div class="maker-q-field"><label class="maker-q-label">🔀 Prompt Fragments in Correct Order <span class="text-muted">(comma-separated)</span></label><input type="text" class="maker-q-words" placeholder="e.g. Summarize, this document, into 3, bullet points"></div>`;
    } else if (typeSelect === "type-answer") {
        html += `
            <div class="maker-q-guide" style="background: rgba(255,255,255,0.05); border-left: 3px solid #a855f7; padding: 0.75rem; margin-bottom: 1rem; border-radius: 0 4px 4px 0; font-size: 0.85rem; color: #cbd5e1;">
                <strong>💡 How it works:</strong> Players must type an exact string. It is case-insensitive, but spelling must be perfect.
            </div>
            <div class="maker-q-field"><label class="maker-q-label">✅ Exact Output Match <span class="text-muted">(case-insensitive)</span></label><input type="text" class="maker-q-answer" placeholder="e.g. Copilot"></div>`;
    } else if (typeSelect === "number-guess") {
        html += `
            <div class="maker-q-guide" style="background: rgba(255,255,255,0.05); border-left: 3px solid #f97316; padding: 0.75rem; margin-bottom: 1rem; border-radius: 0 4px 4px 0; font-size: 0.85rem; color: #cbd5e1;">
                <strong>💡 How it works:</strong> Players drag a slider from 0.0 to 1.0 to guess the optimal AI Temperature. Provide the correct target temperature below.
            </div>
            <div class="maker-q-field"><label class="maker-q-label">🎯 Target Temperature <span class="text-muted">(0.0 to 1.0)</span></label><input type="number" class="maker-q-number" min="0" max="1" step="0.1" placeholder="e.g. 0.7"></div>`;
    } else if (typeSelect === "poll") {
        html += `
            <div class="maker-q-guide" style="background: rgba(255,255,255,0.05); border-left: 3px solid #22c55e; padding: 0.75rem; margin-bottom: 1rem; border-radius: 0 4px 4px 0; font-size: 0.85rem; color: #cbd5e1;">
                <strong>💡 How it works:</strong> No right or wrong answers. Players vote on an option, and the host screen shows a live bar chart of the group's consensus. No points are awarded.
            </div>
            <div class="maker-q-field"><label class="maker-q-label">Poll Options <span class="text-muted">(comma-separated)</span></label><input type="text" class="maker-q-poll-opts" placeholder="e.g. Daily, Weekly, Monthly, Never"></div>`;
    } else if (typeSelect === "speed-math") {
        html += `
            <div class="maker-q-guide" style="background: rgba(255,255,255,0.05); border-left: 3px solid #FFD700; padding: 0.75rem; margin-bottom: 1rem; border-radius: 0 4px 4px 0; font-size: 0.85rem; color: #cbd5e1;">
                <strong>💡 How it works:</strong> Prompt Golf! Players type a full prompt to achieve your Goal. If their prompt contains your Required Keywords, they score points based on how short their prompt is!
            </div>
            <div class="maker-q-field"><label class="maker-q-label">🔑 Required Keywords <span class="text-muted">(comma-separated)</span></label><input type="text" class="maker-q-math-eq" placeholder="e.g. translate, Spanish, formal"></div>`;
    }

    html += `
        <div class="maker-q-field mt-3">
            <label class="maker-q-label">🖼️ Optional Question Image</label>
            <div class="flex items-center gap-2" style="margin-top: 0.25rem;">
                <input type="file" class="maker-q-image-file" accept="image/*" style="display: none;">
                <button type="button" class="btn btn-secondary btn-upload-img-btn" style="padding: 0.4rem 0.8rem; font-size: 0.9rem; border-radius: var(--radius-md);">Upload Image</button>
                <span class="maker-q-img-name text-muted text-small" style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">No file selected</span>
                <button type="button" class="btn btn-danger btn-clear-img-btn hidden" style="padding: 0.4rem 0.8rem; font-size: 0.9rem; background: #ef4444; border: none; border-radius: var(--radius-md); color: white; cursor: pointer;">Remove</button>
            </div>
            <div class="maker-q-img-preview-container mt-2 hidden" style="max-width: 120px; border: 1px solid var(--glass-border); border-radius: var(--radius-md); overflow: hidden;">
                <img class="maker-q-img-preview" src="" style="width: 100%; display: block;">
            </div>
        </div>
    `;

    html += `<div class="maker-q-field" style="max-width:200px; margin-top: 1rem;"><label class="maker-q-label">⏱ Time Limit (seconds)</label><input type="number" class="maker-q-time" value="20" min="5" max="120"></div>`;
    qBlock.innerHTML = html;

    const fileInput = qBlock.querySelector(".maker-q-image-file");
    const uploadBtn = qBlock.querySelector(".btn-upload-img-btn");
    const clearBtn = qBlock.querySelector(".btn-clear-img-btn");
    const nameSpan = qBlock.querySelector(".maker-q-img-name");
    const previewContainer = qBlock.querySelector(".maker-q-img-preview-container");
    const previewImg = qBlock.querySelector(".maker-q-img-preview");

    uploadBtn.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;

        nameSpan.innerText = file.name;
        clearBtn.classList.remove("hidden");

        const reader = new FileReader();
        reader.onload = (evt) => {
            const base64Image = evt.target.result;
            previewImg.src = base64Image;
            previewContainer.classList.remove("hidden");
            qBlock.setAttribute("data-image", base64Image);
        };
        reader.readAsDataURL(file);
    });

    clearBtn.addEventListener("click", () => {
        fileInput.value = "";
        nameSpan.innerText = "No file selected";
        clearBtn.classList.add("hidden");
        previewContainer.classList.add("hidden");
        previewImg.src = "";
        qBlock.removeAttribute("data-image");
    });

    qBlock.querySelector(".maker-remove-btn").addEventListener("click", () => {
        qBlock.style.animation = "slideOutBlock 0.3s ease forwards";
        setTimeout(() => { qBlock.remove(); updateMakerCount(); }, 280);
    });

    qBlock.querySelector(".maker-preview-btn").addEventListener("click", () => {
        if (typeof compileQuestionFromBlock === 'function') {
            const qObj = compileQuestionFromBlock(qBlock);
            if (qObj) showPreviewModal([qObj], 0);
        }
    });

    qBlock.querySelector(".maker-sample-btn")?.addEventListener("click", () => {
        const samples = SAMPLE_DATA[typeSelect];
        if (!samples || samples.length === 0) return;
        const q = samples[Math.floor(Math.random() * samples.length)];
        
        const qTextEl = qBlock.querySelector(".maker-q-text");
        if (qTextEl) qTextEl.value = q.text || "";
        
        if (typeSelect === "multiple-choice") {
            const opts = qBlock.querySelectorAll(".maker-q-opt");
            const radios = qBlock.querySelectorAll(".maker-q-correct");
            q.options.forEach((optStr, i) => { if (opts[i]) opts[i].value = optStr; });
            if (q.correct !== undefined && radios[q.correct]) radios[q.correct].checked = true;
        } else if (typeSelect === "jumbled-prompt") {
            const wordInput = qBlock.querySelector(".maker-q-words");
            if (wordInput && q.words) wordInput.value = q.words.join(", ");
        } else if (typeSelect === "type-answer") {
            const ansInput = qBlock.querySelector(".maker-q-answer");
            if (ansInput) ansInput.value = q.answerText || "";
        } else if (typeSelect === "number-guess") {
            const numInput = qBlock.querySelector(".maker-q-number");
            if (numInput && q.targetNumber !== undefined) numInput.value = q.targetNumber;
        } else if (typeSelect === "poll") {
            const pollInput = qBlock.querySelector(".maker-q-poll-opts");
            if (pollInput && q.options) pollInput.value = q.options.join(", ");
        } else if (typeSelect === "speed-math") {
            const eqInput = qBlock.querySelector(".maker-q-math-eq");
            const ansInput = qBlock.querySelector(".maker-q-math-ans");
            if (eqInput) eqInput.value = q.equation || "";
            if (ansInput && q.answerNumber !== undefined) ansInput.value = q.answerNumber;
        }
    });

    qBlock.querySelector(".maker-up-btn")?.addEventListener("click", () => {
        if (qBlock.previousElementSibling) {
            qBlock.parentNode.insertBefore(qBlock, qBlock.previousElementSibling);
            qBlock.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    });

    qBlock.querySelector(".maker-down-btn")?.addEventListener("click", () => {
        if (qBlock.nextElementSibling) {
            qBlock.parentNode.insertBefore(qBlock.nextElementSibling, qBlock);
            qBlock.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    });

    return qBlock;
}


function setupHostManagementWorkflow() {
    document.getElementById("btn-open-maker")?.addEventListener("click", () => {
        editingQuizIndex = null;
        document.getElementById("maker-quiz-title").value = "";
        const container = document.getElementById("maker-questions-container");
        if (container) {
            container.innerHTML = `
                <div id="maker-empty-state" class="maker-empty-state">
                    <div style="font-size:4rem;margin-bottom:1rem">🎮</div>
                    <h3 style="color:var(--color-cyan)">Start Building!</h3>
                    <p class="text-muted mt-2">Click a question type on the left panel to add it here.</p>
                </div>`;
        }
        updateMakerCount();
        switchView("adminMaker");
    });
    document.getElementById("btn-close-maker")?.addEventListener("click", () => enterHostDashboard());

    // Sidebar type buttons — click to add
    document.querySelectorAll(".maker-type-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const type = btn.getAttribute("data-type");
            const container = document.getElementById("maker-questions-container");
            const emptyState = document.getElementById("maker-empty-state");
            if (emptyState) emptyState.remove();
            const block = buildMakerBlock(type);
            container.appendChild(block);
            block.scrollIntoView({ behavior: "smooth", block: "nearest" });
            updateMakerCount();
            btn.classList.add("maker-type-btn-flash");
            setTimeout(() => btn.classList.remove("maker-type-btn-flash"), 400);
        });
    });

    document.getElementById("btn-preview-quiz")?.addEventListener("click", () => {
        const qBlocks = document.querySelectorAll(".maker-q-block");
        if (qBlocks.length === 0) { alert("Add at least one question to preview!"); return; }
        if (typeof compileQuestionFromBlock === 'function') {
            const qs = Array.from(qBlocks).map(b => compileQuestionFromBlock(b));
            showPreviewModal(qs, 0);
        }
    });

    document.getElementById("btn-save-quiz")?.addEventListener("click", async () => {
        const title = document.getElementById("maker-quiz-title").value.trim();
        if (!title) { alert("Give your quiz a title first!"); return; }
        const qBlocks = document.querySelectorAll(".maker-q-block");
        if (qBlocks.length === 0) { alert("Add at least one question first!"); return; }

        const newQuiz = { title, questions: [] };
        let valid = true;
        let firstInvalidBlock = null;

        qBlocks.forEach(block => {
            block.classList.remove("validation-error");
            
            const markInvalid = () => {
                valid = false;
                block.classList.add("validation-error");
                if (!firstInvalidBlock) firstInvalidBlock = block;
            };

            const qType = block.getAttribute("data-qtype");
            const qText = (block.querySelector(".maker-q-text")?.value || "").trim();
            const qTime = parseInt(block.querySelector(".maker-q-time")?.value) || 20;
            if (!qText) { markInvalid(); return; }
            const qImage = block.getAttribute("data-image") || "";
            const qObj = { type: qType, text: qText, timeLimit: qTime, image: qImage };

            if (qType === "multiple-choice") {
                const opts = Array.from(block.querySelectorAll(".maker-q-opt")).map(i => i.value.trim()).filter(v => v);
                if (opts.length < 2) { markInvalid(); return; }
                const checkedRadio = block.querySelector(".maker-q-correct:checked");
                const correctIdx = checkedRadio ? parseInt(checkedRadio.value) : 0;
                qObj.options = opts; qObj.correct = Math.min(correctIdx, opts.length - 1);
            } else if (qType === "true-false") {
                qObj.options = ["True", "False"]; qObj.correct = 0;
            } else if (qType === "jumbled-prompt") {
                const words = (block.querySelector(".maker-q-words")?.value || "").split(",").map(w => w.trim()).filter(w => w);
                if (words.length < 2) { markInvalid(); return; }
                qObj.words = words;
            } else if (qType === "type-answer") {
                const ans = block.querySelector(".maker-q-answer")?.value.trim();
                if (!ans) { markInvalid(); return; }
                qObj.answerText = ans;
            } else if (qType === "number-guess") {
                const num = parseFloat(block.querySelector(".maker-q-number")?.value);
                if (isNaN(num)) { markInvalid(); return; }
                qObj.targetNumber = num;
            } else if (qType === "poll") {
                const opts = (block.querySelector(".maker-q-poll-opts")?.value || "").split(",").map(o => o.trim()).filter(o => o);
                if (opts.length < 2) { markInvalid(); return; }
                qObj.options = opts; qObj.isPoll = true;
            } else if (qType === "speed-math") {
                const eq = block.querySelector(".maker-q-math-eq")?.value.trim();
                if (!eq) { markInvalid(); return; }
                qObj.equation = eq;
            }
            newQuiz.questions.push(qObj);
        });

        if (!valid) { 
            alert("Some questions have missing fields. They have been highlighted in red."); 
            if (firstInvalidBlock) firstInvalidBlock.scrollIntoView({ behavior: "smooth", block: "center" });
            return; 
        }
        
        if (editingQuizIndex !== null) {
            copilotPresets[editingQuizIndex] = newQuiz;
        } else {
            copilotPresets.push(newQuiz);
        }

        try {
            localStorage.setItem("copilot_custom_quizzes", JSON.stringify(copilotPresets));
        } catch (e) {}
        await syncPresetsToFirebase();
        enterHostDashboard();
    });
}

async function syncPresetsToFirebase() {
    if (!isFirebaseEnabled) return;
    try {
        await set(ref(database, 'quizzes/global'), copilotPresets);
    } catch (err) {
        console.warn("Firebase sync failed:", err);
    }
}

async function loadPresetsFromFirebase() {
    if (!isFirebaseEnabled) return;
    try {
        const snap = await get(ref(database, 'quizzes/global'));
        if (snap.exists()) {
            copilotPresets = snap.val();
            localStorage.setItem("copilot_custom_quizzes", JSON.stringify(copilotPresets));
        }
    } catch (err) {
        console.warn("Firebase load failed:", err);
    }
}

async function enterHostDashboard() {
    currentRole = "host";
    await loadPresetsFromFirebase();
    switchView("hostSetup");
    renderQuizSelector();
    
    let history = [];
    try {
        const savedHistory = localStorage.getItem("copilot_recent_sessions");
        if (savedHistory) {
            history = JSON.parse(savedHistory);
        }
    } catch (e) {
        history = [];
    }

    let workshops = 0;
    let totalPlayers = 0;
    let avgEngagement = 0;

    if (history.length > 0) {
        workshops = history.length;
        totalPlayers = history.reduce((sum, item) => sum + (item.playersCount || 0), 0);
        const totalAccuracy = history.reduce((sum, item) => sum + (item.accuracy || 0), 0);
        avgEngagement = Math.round(totalAccuracy / history.length);
    }

    document.getElementById("metric-workshops").innerText = workshops;
    document.getElementById("metric-players").innerText = totalPlayers;
    document.getElementById("metric-score").innerText = avgEngagement + "%";

    const historyList = document.getElementById("history-list");
    if (historyList) {
        historyList.innerHTML = "";
        if (history.length === 0) {
            historyList.innerHTML = `
                <tr>
                    <td colspan="4" class="text-center text-muted text-small py-3">No recent sessions found.</td>
                </tr>
            `;
        } else {
            [...history].reverse().forEach((session, idx) => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td class="text-small py-2">${session.date}</td>
                    <td class="text-small py-2" style="font-weight: 500;">${session.quizTitle}</td>
                    <td class="text-small py-2 text-center">${session.playersCount}</td>
                    <td class="text-small py-2 text-center">
                        <button class="btn btn-danger btn-delete-session" data-index="${history.length - 1 - idx}" style="padding: 0.25rem 0.5rem; background:#ef4444; border:none; border-radius:var(--radius-sm); color:white; cursor:pointer; font-size:0.8rem;">Delete</button>
                    </td>
                `;
                historyList.appendChild(tr);
            });

            historyList.querySelectorAll(".btn-delete-session").forEach(btn => {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const targetIdx = parseInt(e.currentTarget.getAttribute("data-index"));
                    if (confirm("Are you sure you want to delete this session record?")) {
                        history.splice(targetIdx, 1);
                        try {
                            localStorage.setItem("copilot_recent_sessions", JSON.stringify(history));
                        } catch (err) {}
                        enterHostDashboard();
                    }
                });
            });
        }
    }
}

function renderQuizSelector() {
    const listContainer = document.getElementById("custom-quizzes-list");
    if (!listContainer) return;
    listContainer.innerHTML = "";

    copilotPresets.forEach((quiz, index) => {
        const card = document.createElement("div");
        card.className = "card card-hover fade-in-up";
        card.innerHTML = `
            <h4>${quiz.title}</h4>
            <p class="text-small">${quiz.questions.length} Active System Nodes</p>
            <div class="flex gap-2 mt-3">
                <button class="btn btn-primary flex-1 btn-launch-quiz" data-index="${index}">Initialize Live Room</button>
                <button class="btn btn-secondary btn-edit-quiz" data-index="${index}" style="padding: 0.5rem 0.75rem; border-radius:var(--radius-md);" title="Edit Quiz">✏️</button>
                <button class="btn btn-danger btn-delete-quiz" data-index="${index}" style="padding: 0.5rem 0.75rem; background:#ef4444; border:none; border-radius:var(--radius-md); color:white; cursor:pointer;" title="Delete Quiz">🗑️</button>
            </div>
        `;
        listContainer.appendChild(card);
    });

    listContainer.querySelectorAll(".btn-launch-quiz").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const idx = parseInt(e.currentTarget.getAttribute("data-index"));
            initializeLiveRoom(copilotPresets[idx]);
        });
    });

    listContainer.querySelectorAll(".btn-edit-quiz").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const idx = parseInt(e.currentTarget.getAttribute("data-index"));
            loadQuizIntoMaker(idx);
        });
    });

    listContainer.querySelectorAll(".btn-delete-quiz").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(e.currentTarget.getAttribute("data-index"));
            if (confirm(`Are you sure you want to delete the quiz "${copilotPresets[idx].title}"?`)) {
                copilotPresets.splice(idx, 1);
                try {
                    localStorage.setItem("copilot_custom_quizzes", JSON.stringify(copilotPresets));
                } catch(err) {}
                syncPresetsToFirebase();
                renderQuizSelector();
            }
        });
    });
}

function loadQuizIntoMaker(index) {
    const quiz = copilotPresets[index];
    if (!quiz) return;

    editingQuizIndex = index;
    document.getElementById("maker-quiz-title").value = quiz.title;
    const container = document.getElementById("maker-questions-container");
    container.innerHTML = "";

    quiz.questions.forEach(q => {
        const block = buildMakerBlock(q.type);
        container.appendChild(block);
        
        const qTextEl = block.querySelector(".maker-q-text");
        if (qTextEl) qTextEl.value = q.text || "";
        
        const qTimeEl = block.querySelector(".maker-q-time");
        if (qTimeEl) qTimeEl.value = q.timeLimit || 20;

        if (q.image) {
            block.setAttribute("data-image", q.image);
            const nameSpan = block.querySelector(".maker-q-img-name");
            const previewContainer = block.querySelector(".maker-q-img-preview-container");
            const previewImg = block.querySelector(".maker-q-img-preview");
            const clearBtn = block.querySelector(".btn-clear-img-btn");
            if (nameSpan) nameSpan.innerText = "Saved Image";
            if (previewImg) previewImg.src = q.image;
            if (previewContainer) previewContainer.classList.remove("hidden");
            if (clearBtn) clearBtn.classList.remove("hidden");
        }

        if (q.type === "multiple-choice") {
            const opts = block.querySelectorAll(".maker-q-opt");
            const radios = block.querySelectorAll(".maker-q-correct");
            q.options.forEach((optStr, i) => {
                if (opts[i]) opts[i].value = optStr;
            });
            if (q.correct !== undefined && radios[q.correct]) {
                radios[q.correct].checked = true;
            }
        } else if (q.type === "jumbled-prompt") {
            const wordInput = block.querySelector(".maker-q-words");
            if (wordInput && q.words) wordInput.value = q.words.join(", ");
        } else if (q.type === "type-answer") {
            const ansInput = block.querySelector(".maker-q-answer");
            if (ansInput) ansInput.value = q.answerText || "";
        } else if (q.type === "number-guess") {
            const numInput = block.querySelector(".maker-q-number");
            if (numInput && q.targetNumber !== undefined) numInput.value = q.targetNumber;
        } else if (q.type === "poll") {
            const pollInput = block.querySelector(".maker-q-poll-opts");
            if (pollInput && q.options) pollInput.value = q.options.join(", ");
        } else if (q.type === "speed-math") {
            const eqInput = block.querySelector(".maker-q-math-eq");
            const ansInput = block.querySelector(".maker-q-math-ans");
            if (eqInput) eqInput.value = q.equation || "";
            if (ansInput && q.answerNumber !== undefined) ansInput.value = q.answerNumber;
        }
    });

    updateMakerCount();
    switchView("adminMaker");
}

async function initializeLiveRoom(quiz) {
    currentQuizData = quiz;
    currentSessionPin = Math.floor(100000 + Math.random() * 900000).toString();
    sessionTotalAnswersCount = 0;
    sessionTotalCorrectAnswersCount = 0;

    document.getElementById("display-game-pin").innerText = currentSessionPin;
    document.getElementById("display-join-url").innerHTML = `Join at <strong>${window.location.origin}</strong>`;

    const qrContainer = document.getElementById("qr-code-container");
    if (qrContainer) {
        qrContainer.innerHTML = "";
        new QRCode(qrContainer, {
            text: `${window.location.origin}?pin=${currentSessionPin}`,
            width: 160, height: 160, colorDark: "#0A2E5C", colorLight: "#FFFFFF"
        });
    }

    if (isFirebaseEnabled) {
        gameSessionRef = ref(database, `sessions/${currentSessionPin}`);
        await set(gameSessionRef, { status: "lobby", quizTitle: quiz.title, currentQuestion: -1, timestamp: Date.now() });
        trackLobbyRegistrations();
    } else {
        document.getElementById("btn-start-game").disabled = false;
    }
    switchView("hostLobby");
}

function trackLobbyRegistrations() {
    if (!gameSessionRef) return;
    const countDisplay = document.getElementById("player-count");
    const listGrid = document.getElementById("player-list");
    const startBtn = document.getElementById("btn-start-game");

    playerLobbyListener = onValue(ref(database, `sessions/${currentSessionPin}/players`), (snapshot) => {
        listGrid.innerHTML = "";
        if (!snapshot.exists()) {
            countDisplay.innerText = "0";
            startBtn.disabled = true;
            return;
        }
        const data = snapshot.val();
        const keys = Object.keys(data);
        countDisplay.innerText = keys.length;
        startBtn.disabled = keys.length === 0;

        keys.forEach(k => {
            const tag = document.createElement("div");
            tag.className = "player-tag";
            tag.innerHTML = `<span>${data[k].nickname}</span><button class="btn-kick" data-key="${k}">×</button>`;
            listGrid.appendChild(tag);
        });

        listGrid.querySelectorAll(".btn-kick").forEach(btn => {
            btn.addEventListener("click", (e) => {
                const targetKey = e.currentTarget.getAttribute("data-key");
                remove(ref(database, `sessions/${currentSessionPin}/players/${targetKey}`));
            });
        });
    });

    emojiListener = onChildAdded(ref(database, `sessions/${currentSessionPin}/reactions`), (snapshot) => {
        if (snapshot.exists()) spawnReactionOnHostScreen(snapshot.val().emoji);
    });

    document.getElementById("btn-start-game").onclick = () => { hostActiveQuestionIndex = 0; executeQuestionBroadcast(); };
    document.getElementById("btn-cancel-session").onclick = () => terminateRoomInstance();
    const btnEndEarly = document.getElementById("btn-host-end-game-early");
    if (btnEndEarly) {
        btnEndEarly.onclick = () => {
            if (confirm("End game early and skip to final results?")) {
                hostActiveQuestionIndex = currentQuizData.questions.length;
                clearInterval(timerInterval);
                presentHostLeaderboardView();
            }
        };
    }
}

async function terminateRoomInstance() {
    purgeActiveListeners();
    if (isFirebaseEnabled && currentSessionPin) await remove(ref(database, `sessions/${currentSessionPin}`));
    enterHostDashboard();
}

// ==========================================
// 5. HOST QUESTION BROADCAST ENGINE
// ==========================================
async function executeQuestionBroadcast() {
    isTimerPaused = false;
    document.getElementById("btn-pause-timer").classList.remove("hidden");
    document.getElementById("btn-resume-timer").classList.add("hidden");

    const q = currentQuizData.questions[hostActiveQuestionIndex];
    hostAnswersMap = {};

    document.getElementById("host-question-text").innerText = q.text;
    const hNumber = document.getElementById("host-question-number");
    if(hNumber) hNumber.innerText = `Question ${hostActiveQuestionIndex + 1} of ${currentQuizData.questions.length}`;
    
    const imgContainer = document.getElementById("host-question-image-container");
    const imgEl = document.getElementById("host-question-image");
    if (imgContainer && imgEl) {
        if (q.image) {
            imgEl.src = q.image;
            imgContainer.classList.remove("hidden");
        } else {
            imgEl.src = "";
            imgContainer.classList.add("hidden");
        }
    }
    
    const mcContainer = document.getElementById("host-ans-container-mc");
    const tfContainer = document.getElementById("host-ans-container-tf");
    const jumbledContainer = document.getElementById("host-ans-container-jumbled");
    const textContainer = document.getElementById("host-ans-container-text");
    const numberContainer = document.getElementById("host-ans-container-number");
    const pollContainer = document.getElementById("host-ans-container-poll");
    const speedmathContainer = document.getElementById("host-ans-container-speedmath");
    
    if (mcContainer) mcContainer.classList.add("hidden");
    if (tfContainer) tfContainer.classList.add("hidden");
    if (jumbledContainer) jumbledContainer.classList.add("hidden");
    if (textContainer) textContainer.classList.add("hidden");
    if (numberContainer) numberContainer.classList.add("hidden");
    if (pollContainer) pollContainer.classList.add("hidden");
    if (speedmathContainer) speedmathContainer.classList.add("hidden");

    if (!q.type || q.type === "multiple-choice") {
        if (mcContainer) mcContainer.classList.remove("hidden");
        document.getElementById("host-ans-0").innerText = q.options[0] || "";
        document.getElementById("host-ans-1").innerText = q.options[1] || "";
        document.getElementById("host-ans-2").innerText = q.options[2] || "";
        document.getElementById("host-ans-3").innerText = q.options[3] || "";
    } else if (q.type === "true-false") {
        if (tfContainer) tfContainer.classList.remove("hidden");
        document.getElementById("host-ans-tf-0").innerText = q.options[0] || "True";
        document.getElementById("host-ans-tf-1").innerText = q.options[1] || "False";
    } else if (q.type === "jumbled-prompt") {
        if (jumbledContainer) jumbledContainer.classList.remove("hidden");
        const container = document.getElementById("host-jumbled-words");
        if (container) {
            container.innerHTML = "";
            const scrambled = [...q.words].sort(() => Math.random() - 0.5);
            scrambled.forEach(w => {
                const span = document.createElement("span");
                span.className = "jumbled-word-chip";
                span.innerText = w;
                container.appendChild(span);
            });
        }
    } else if (q.type === "type-answer") {
        if (textContainer) textContainer.classList.remove("hidden");
    } else if (q.type === "number-guess") {
        if (numberContainer) numberContainer.classList.remove("hidden");
    } else if (q.type === "poll") {
        if (pollContainer) pollContainer.classList.remove("hidden");
    } else if (q.type === "speed-math") {
        if (speedmathContainer) speedmathContainer.classList.remove("hidden");
        const eqDisplay = document.getElementById("host-math-equation-display");
        if (eqDisplay) {
            eqDisplay.innerText = q.equation || "";
        }
    }

    document.getElementById("answers-count").innerText = "0 Answers";

    if (isFirebaseEnabled) {
        await update(gameSessionRef, { 
            status: "question", 
            currentQuestion: hostActiveQuestionIndex,
            timeLimit: q.timeLimit || 20,
            questionType: q.type || "multiple-choice",
            questionWords: q.words || null,
            questionOptions: q.options || null,
            questionEquation: q.equation || null,
            questionStartTime: Date.now() 
        });
        if (answersListener) answersListener();
        answersListener = onValue(ref(database, `sessions/${currentSessionPin}/answers`), (snapshot) => {
            if (snapshot.exists()) {
                hostAnswersMap = snapshot.val();
                document.getElementById("answers-count").innerText = `${Object.keys(hostAnswersMap).length} Answers`;
            }
        });
    }

    switchView("hostQuestion");
    runTimerCountdown(q.timeLimit);
}

function runTimerCountdown(duration) {
    clearInterval(timerInterval);
    timeLeft = duration;

    const timerUI = document.getElementById("host-timer");
    timerUI.innerText = timeLeft;
    timerUI.classList.remove("timer-warning");
    timerUI.style.borderColor = THEME_COLORS.primary;
    timerUI.style.boxShadow = `0 0 20px rgba(0, 230, 242, 0.3)`;

    timerInterval = setInterval(() => {
        if (isTimerPaused) return;
        timeLeft--;
        timerUI.innerText = timeLeft;

        if (timeLeft <= 5) {
            timerUI.classList.add("timer-warning");
            timerUI.style.borderColor = "#ef4444";
            timerUI.style.boxShadow = `0 0 20px rgba(239, 68, 68, 0.6)`;
            try { sfx.tick.currentTime = 0; sfx.tick.play(); } catch (e) { }
        }

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            concludeQuestionEvaluation();
        }
    }, 1000);

    document.getElementById("btn-pause-timer").onclick = () => {
        isTimerPaused = true;
        document.getElementById("btn-pause-timer").classList.add("hidden");
        document.getElementById("btn-resume-timer").classList.remove("hidden");
    };

    document.getElementById("btn-resume-timer").onclick = () => {
        isTimerPaused = false;
        document.getElementById("btn-resume-timer").classList.add("hidden");
        document.getElementById("btn-pause-timer").classList.remove("hidden");
    };

    document.getElementById("btn-skip-question").onclick = () => {
        clearInterval(timerInterval);
        concludeQuestionEvaluation();
    };
}

async function concludeQuestionEvaluation() {
    if (answersListener) { answersListener(); answersListener = null; }
    const q = currentQuizData.questions[hostActiveQuestionIndex];
    
    document.getElementById("host-results-chart").classList.add("hidden");
    const jumbledResults = document.getElementById("host-results-jumbled");
    const textResults = document.getElementById("host-results-text");
    const numberResults = document.getElementById("host-results-number");
    const mcCorrectAns = document.getElementById("host-mc-correct-answer");
    if (mcCorrectAns) mcCorrectAns.classList.add("hidden");
    
    if (jumbledResults) jumbledResults.classList.add("hidden");
    if (textResults) textResults.classList.add("hidden");
    if (numberResults) numberResults.classList.add("hidden");

    if (!q.type || q.type === "multiple-choice" || q.type === "true-false" || q.type === "poll") {
        document.getElementById("host-results-chart").classList.remove("hidden");
        if (mcCorrectAns && q.type !== "poll" && q.correct !== undefined && q.options && q.options[q.correct]) {
            mcCorrectAns.classList.remove("hidden");
            document.getElementById("host-mc-correct-text").innerText = q.options[q.correct];
        }
        const numOptions = (q.options && q.options.length) ? q.options.length : 4;
        const distribution = Array(numOptions).fill(0);

        Object.values(hostAnswersMap).forEach(ans => {
            if (ans.optionIndex >= 0 && ans.optionIndex < numOptions) distribution[ans.optionIndex]++;
        });

        const totalAnswers = Object.keys(hostAnswersMap).length || 1;
        for (let i = 0; i < 4; i++) {
            const barElement = document.getElementById(`bar-${i}`);
            const barContainer = barElement ? barElement.parentElement : null;
            if (barElement) {
                if (barContainer) barContainer.style.opacity = "1";
                if (i < numOptions) {
                    if (barContainer) barContainer.classList.remove("hidden");
                    const heightPercent = (distribution[i] / totalAnswers) * 100;
                    barElement.style.height = `${heightPercent}%`;
                    
                    if (q.type !== "poll" && q.correct !== undefined) {
                        if (i === q.correct) {
                            barElement.nextElementSibling.innerHTML = `${distribution[i]} <span style="color:#22c55e;">✔</span>`;
                        } else {
                            barElement.nextElementSibling.innerText = distribution[i];
                            if (barContainer) barContainer.style.opacity = "0.4";
                        }
                    } else {
                        barElement.nextElementSibling.innerText = distribution[i];
                    }
                } else {
                    if (barContainer) barContainer.classList.add("hidden");
                }
            }
        }
    } else if (q.type === "jumbled-prompt") {
        if (jumbledResults) {
            jumbledResults.classList.remove("hidden");
            let correctCount = 0;
            Object.values(hostAnswersMap).forEach(ans => {
                if (ans.sequence && ans.sequence.join(',') === q.words.join(',')) correctCount++;
            });
            document.getElementById("host-jumbled-correct-count").innerText = `${correctCount} participants ordered it correctly!`;
            const correctOrderEl = document.getElementById("host-jumbled-correct-order");
            correctOrderEl.innerHTML = "";
            q.words.forEach(w => {
                const span = document.createElement("span");
                span.className = "jumbled-word-chip correct";
                span.innerText = w;
                correctOrderEl.appendChild(span);
            });
        }
    } else if (q.type === "type-answer") {
        if (textResults) {
            textResults.classList.remove("hidden");
            let correctCount = 0;
            Object.values(hostAnswersMap).forEach(ans => {
                if (ans.textAnswer && ans.textAnswer.toLowerCase() === q.answerText.toLowerCase()) correctCount++;
            });
            document.getElementById("host-text-correct-count").innerText = `${correctCount} participants typed it correctly!`;
            document.getElementById("host-text-correct-answer").innerText = q.answerText;
        }
    } else if (q.type === "number-guess") {
        if (numberResults) {
            numberResults.classList.remove("hidden");
            document.getElementById("host-number-correct-answer").innerText = q.targetNumber;
            
            let closest = null;
            let closestDiff = Infinity;
            
            Object.entries(hostAnswersMap).forEach(([pKey, ans]) => {
                if (ans.numberAnswer !== undefined) {
                    const diff = Math.abs(ans.numberAnswer - q.targetNumber);
                    if (diff < closestDiff) {
                        closestDiff = diff;
                        closest = { pKey, val: ans.numberAnswer };
                    }
                }
            });
            
            const closestMsg = document.getElementById("host-number-closest");
            if (closest) {
                closestMsg.innerText = `Closest tune was ${closest.val} (off by ${closestDiff.toFixed(2)})!`;
                if (closestDiff < 0.01) closestMsg.innerText = `Someone tuned it exactly!`;
            } else {
                closestMsg.innerText = `No tuning submitted.`;
            }
        }
    } else if (q.type === "speed-math") {
        if (textResults) {
            textResults.classList.remove("hidden");
            let correctCount = 0;
            Object.values(hostAnswersMap).forEach(ans => {
                if (ans.textAnswer !== undefined) {
                    const ansLower = ans.textAnswer.toLowerCase();
                    const keywords = q.equation.split(",").map(k => k.trim().toLowerCase()).filter(k => k);
                    const allPresent = keywords.every(k => ansLower.includes(k));
                    if (allPresent) correctCount++;
                }
            });
            document.getElementById("host-text-correct-count").innerText = `${correctCount} participants included all keywords!`;
            document.getElementById("host-text-correct-answer").innerText = `Keywords: ${q.equation}`;
        }
    }

    if (isFirebaseEnabled) {
        await update(gameSessionRef, { status: "results" });
        await evaluateSystemScoringTransactions(q.correct);
    }

    try { sfx.ding.play(); } catch (e) { }
    switchView("hostResults");
    document.getElementById("btn-next-leaderboard").onclick = () => presentHostLeaderboardView();
}

async function evaluateSystemScoringTransactions(correctIdx) {
    const playersSnapshot = await get(ref(database, `sessions/${currentSessionPin}/players`));
    if (!playersSnapshot.exists()) return;

    const playersData = playersSnapshot.val();
    const updates = {};

    Object.keys(playersData).forEach(pKey => {
        const answerObj = hostAnswersMap[pKey];
        let scoreIncrement = 0;
        let answeredCorrectly = false;

        const currentQ = currentQuizData.questions[hostActiveQuestionIndex];
        if (currentQ.type === "jumbled-prompt") {
            if (answerObj && answerObj.sequence && answerObj.sequence.join(',') === currentQ.words.join(',')) {
                answeredCorrectly = true;
            }
        } else if (currentQ.type === "type-answer") {
            if (answerObj && answerObj.textAnswer && answerObj.textAnswer.toLowerCase() === currentQ.answerText.toLowerCase()) {
                answeredCorrectly = true;
            }
        } else if (currentQ.type === "number-guess") {
            if (answerObj && answerObj.numberAnswer !== undefined) {
                const diff = Math.abs(answerObj.numberAnswer - currentQ.targetNumber);
                if (diff <= 0.15) answeredCorrectly = true; 
            }
        } else if (currentQ.type === "poll") {
            if (answerObj) answeredCorrectly = true; // Everyone who submitted is marked correct/active
        } else if (currentQ.type === "speed-math") {
            if (answerObj && answerObj.textAnswer !== undefined) {
                const ansLower = answerObj.textAnswer.toLowerCase();
                const keywords = currentQ.equation.split(",").map(k => k.trim().toLowerCase()).filter(k => k);
                const allPresent = keywords.every(k => ansLower.includes(k));
                if (allPresent) answeredCorrectly = true;
            }
        } else {
            if (answerObj && answerObj.optionIndex === correctIdx) {
                answeredCorrectly = true;
            }
        }

        if (answeredCorrectly) {
            if (currentQ.type === "poll") {
                scoreIncrement = 0;
            } else if (currentQ.type === "speed-math" && answerObj.textAnswer) {
                const length = answerObj.textAnswer.length;
                const lengthBonus = Math.max(0, 500 - (length * 3));
                scoreIncrement = 500 + lengthBonus;
                const currentStreakInstance = (playersData[pKey].streak || 0) + 1;
                if (currentStreakInstance >= 3) scoreIncrement = Math.round(scoreIncrement * 1.5);
                updates[`players/${pKey}/streak`] = currentStreakInstance;
            } else {
                const durationLimit = (currentQ.timeLimit * 1000) || 20000;
                const scale = Math.max(0.2, 1 - (answerObj.elapsedTime / durationLimit));
                scoreIncrement = Math.round(1000 * scale);
                const currentStreakInstance = (playersData[pKey].streak || 0) + 1;
                if (currentStreakInstance >= 3) scoreIncrement = Math.round(scoreIncrement * 1.5);
                updates[`players/${pKey}/streak`] = currentStreakInstance;
            }
        } else {
            updates[`players/${pKey}/streak`] = 0;
        }

        updates[`players/${pKey}/score`] = (playersData[pKey].score || 0) + scoreIncrement;
        updates[`players/${pKey}/lastPointsEarned`] = scoreIncrement;
        updates[`players/${pKey}/wasCorrect`] = answeredCorrectly;

        if (answerObj) {
            sessionTotalAnswersCount++;
            if (answeredCorrectly) {
                sessionTotalCorrectAnswersCount++;
            }
        }
    });

    await update(gameSessionRef, updates);
}

async function presentHostLeaderboardView() {
    if (!isFirebaseEnabled) {
        switchView("hostLeaderboard");
        return;
    }
    const playersSnapshot = await get(ref(database, `sessions/${currentSessionPin}/players`));
    const listUI = document.getElementById("leaderboard-list");
    listUI.innerHTML = "";

    if (playersSnapshot.exists()) {
        const array = Object.entries(playersSnapshot.val()).map(([key, val]) => ({ key, ...val }));
        array.sort((a, b) => b.score - a.score);
        
        const podiumDisplay = document.getElementById("podium-display");
        if (podiumDisplay) {
            podiumDisplay.classList.remove("hidden");
            const p1 = document.querySelector(".podium-1");
            const p2 = document.querySelector(".podium-2");
            const p3 = document.querySelector(".podium-3");
            
            if(array[0]) { 
                document.getElementById("podium-p1-name").innerText = array[0].nickname; 
                document.getElementById("podium-p1-score").innerText = array[0].score + " pts"; 
                if (p1) p1.style.display = "flex";
            } else { if (p1) p1.style.display = "none"; }
            
            if(array[1]) { 
                document.getElementById("podium-p2-name").innerText = array[1].nickname; 
                document.getElementById("podium-p2-score").innerText = array[1].score + " pts"; 
                if (p2) p2.style.display = "flex"; 
            } else { if (p2) p2.style.display = "none"; }
            
            if(array[2]) { 
                document.getElementById("podium-p3-name").innerText = array[2].nickname; 
                document.getElementById("podium-p3-score").innerText = array[2].score + " pts"; 
                if (p3) p3.style.display = "flex"; 
            } else { if (p3) p3.style.display = "none"; }
        }

        array.slice(3, 10).forEach((player, idx) => {
            const row = document.createElement("div");
            row.className = "leaderboard-row fade-in-up";
            row.innerHTML = `<span>#${idx + 4} ${player.nickname}</span><span>${player.score} pts</span>`;
            listUI.appendChild(row);
        });
    }

    const nextBtn = document.getElementById("btn-next-question");
    const backBtn = document.getElementById("btn-back-dashboard");

    if (hostActiveQuestionIndex + 1 < currentQuizData.questions.length) {
        nextBtn.innerText = "Next Question";
        nextBtn.classList.remove("hidden");
        backBtn.classList.add("hidden");
        nextBtn.onclick = () => { hostActiveQuestionIndex++; executeQuestionBroadcast(); };
    } else {
        nextBtn.classList.add("hidden");
        backBtn.classList.remove("hidden");
        backBtn.innerText = "Conclude Workshop Session";
        await update(gameSessionRef, { status: "gameover" });
        backBtn.onclick = () => {
            const playersCount = playersSnapshot.exists() ? Object.keys(playersSnapshot.val()).length : 0;
            const correctRatio = sessionTotalAnswersCount > 0 ? (sessionTotalCorrectAnswersCount / sessionTotalAnswersCount) : 0.92;
            const sessionScorePercent = Math.round(correctRatio * 100);

            let history = [];
            try {
                const savedHistory = localStorage.getItem("copilot_recent_sessions");
                if (savedHistory) {
                    history = JSON.parse(savedHistory);
                }
            } catch (err) {}

            history.push({
                date: new Date().toLocaleDateString(),
                quizTitle: currentQuizData.title,
                playersCount: playersCount,
                accuracy: sessionScorePercent
            });

            try {
                localStorage.setItem("copilot_recent_sessions", JSON.stringify(history));
            } catch (err) {}

            terminateRoomInstance();
        };
    }
    switchView("hostLeaderboard");
}

// ==========================================
// 6. PLAYER ARCHITECTURE LOGIC PIPELINES
// ==========================================
function setupPlayerParticipationWorkflow() {
    const joinForm = document.getElementById("form-join");
    joinForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const pinInput = document.getElementById("input-pin").value.trim();
        const nameInput = document.getElementById("input-nickname").value.trim();
        const submitBtn = document.getElementById("btn-join-submit");

        if (!isFirebaseEnabled) {
            myNickname = nameInput;
            currentSessionPin = pinInput;
            document.getElementById("display-player-name").innerText = myNickname;
            switchView("playerLobby");
            return;
        }

        try {
            submitBtn.disabled = true;
            const sessionSnap = await get(ref(database, `sessions/${pinInput}`));

            if (!sessionSnap.exists()) {
                alert("Game room code not found.");
                return;
            }
            if (sessionSnap.val().status !== "lobby") {
                alert("Game connection pathway is already closed.");
                return;
            }

            currentSessionPin = pinInput;
            myNickname = nameInput;
            currentRole = "player";

            const playerListRef = ref(database, `sessions/${pinInput}/players`);
            const newPlayerRef = push(playerListRef);
            myPlayerKey = newPlayerRef.key;

            await set(newPlayerRef, { nickname: myNickname, score: 0, streak: 0, lastPointsEarned: 0, wasCorrect: false });
            document.getElementById("display-player-name").innerText = myNickname;
            switchView("playerLobby");
            bindPlayerSessionSyncPipeline();

        } catch (err) {
            console.error("Firebase connection error caught:", err);
            console.warn("Falling back automatically to sandbox fallback loop runtime mode.");
            myNickname = nameInput;
            currentSessionPin = pinInput;
            document.getElementById("display-player-name").innerText = myNickname;
            switchView("playerLobby");
        } finally {
            submitBtn.disabled = false;
        }
    });

    setupPlayerReactionPipelines();
}

function bindPlayerSessionSyncPipeline() {
    if (!currentSessionPin || !myPlayerKey) return;
    sessionStateListener = onValue(ref(database, `sessions/${currentSessionPin}`), (snapshot) => {
        if (!snapshot.exists()) {
            purgeActiveListeners();
            switchView("landing");
            return;
        }
        const session = snapshot.val();
        if (!session.players || !session.players[myPlayerKey]) {
            purgeActiveListeners();
            switchView("landing");
            return;
        }

        switch (session.status) {
            case "lobby": switchView("playerLobby"); break;
            case "question": preparePlayerInputInterface(session); break;
            case "results": renderPlayerResultPanel(session); break;
            case "gameover": listUIFinalLeaderboard(session); break;
        }
    });
}

function preparePlayerInputInterface(session) {
    if (hasAnsweredCurrent) return;
    currentQuestionStartTime = session.questionStartTime || Date.now();
    hasAnsweredCurrent = false;

    document.getElementById("player-score-display").innerText = currentScore;
    document.getElementById("player-waiting-msg").classList.add("hidden");

    const pNumber = document.getElementById("player-question-number");
    if(pNumber) pNumber.innerText = `Question ${(session.currentQuestion || 0) + 1}`;
    
    if(window.potentialPointsInterval) clearInterval(window.potentialPointsInterval);
    const potentialPointsEl = document.getElementById("player-potential-points");
    if(potentialPointsEl) {
        potentialPointsEl.innerText = "1000";
        if(session.questionType !== "poll") {
            const durationLimit = (session.timeLimit || 20) * 1000;
            window.potentialPointsInterval = setInterval(() => {
                if(hasAnsweredCurrent) {
                    clearInterval(window.potentialPointsInterval);
                    return;
                }
                const elapsed = Date.now() - currentQuestionStartTime;
                const scale = Math.max(0.2, 1 - (elapsed / durationLimit));
                potentialPointsEl.innerText = Math.round(1000 * scale);
            }, 100);
        } else {
            potentialPointsEl.innerText = "0";
        }
    }

    const qType = session.questionType || "multiple-choice";
    
    document.getElementById("player-input-mc").classList.add("hidden");
    document.getElementById("player-input-tf").classList.add("hidden");
    document.getElementById("player-input-jumbled").classList.add("hidden");
    document.getElementById("player-input-text").classList.add("hidden");
    document.getElementById("player-input-number").classList.add("hidden");
    document.getElementById("player-input-poll").classList.add("hidden");
    document.getElementById("player-input-speedmath").classList.add("hidden");

    switchView("playerQuestion");

    if (qType === "multiple-choice") {
        document.getElementById("player-input-mc").classList.remove("hidden");
        const btns = document.getElementById("player-input-mc").querySelectorAll(".answer-btn");
        btns.forEach(btn => { btn.classList.remove("selected", "disabled-answer"); btn.disabled = false; });
        btns.forEach(btn => {
            btn.onclick = async (e) => {
                const chosenIdx = parseInt(e.currentTarget.getAttribute("data-index"));
                hasAnsweredCurrent = true;
                btns.forEach(b => { b.disabled = true; if (b !== e.currentTarget) b.classList.add("disabled-answer"); });
                e.currentTarget.classList.add("selected");
                if (isFirebaseEnabled && myPlayerKey) {
                    await set(ref(database, `sessions/${currentSessionPin}/answers/${myPlayerKey}`), { optionIndex: chosenIdx, elapsedTime: Date.now() - currentQuestionStartTime });
                    document.getElementById("player-waiting-msg").classList.remove("hidden");
                }
            };
        });
    } else if (qType === "true-false") {
        document.getElementById("player-input-tf").classList.remove("hidden");
        const btns = document.getElementById("player-input-tf").querySelectorAll(".answer-btn");
        btns.forEach(btn => { btn.classList.remove("selected", "disabled-answer"); btn.disabled = false; });
        btns.forEach(btn => {
            btn.onclick = async (e) => {
                const chosenIdx = parseInt(e.currentTarget.getAttribute("data-index"));
                hasAnsweredCurrent = true;
                btns.forEach(b => { b.disabled = true; if (b !== e.currentTarget) b.classList.add("disabled-answer"); });
                e.currentTarget.classList.add("selected");
                if (isFirebaseEnabled && myPlayerKey) {
                    await set(ref(database, `sessions/${currentSessionPin}/answers/${myPlayerKey}`), { optionIndex: chosenIdx, elapsedTime: Date.now() - currentQuestionStartTime });
                    document.getElementById("player-waiting-msg").classList.remove("hidden");
                }
            };
        });
    } else if (qType === "jumbled-prompt") {
        document.getElementById("player-input-jumbled").classList.remove("hidden");
        renderPlayerJumbledPrompt(session.questionWords);
    } else if (qType === "type-answer") {
        document.getElementById("player-input-text").classList.remove("hidden");
        const inputEl = document.getElementById("input-type-answer");
        const submitBtn = document.getElementById("btn-submit-type-answer");
        inputEl.value = "";
        inputEl.disabled = false;
        submitBtn.disabled = false;
        
        submitBtn.onclick = async () => {
            if (hasAnsweredCurrent) return;
            const typedAns = inputEl.value.trim();
            if (!typedAns) return;
            
            hasAnsweredCurrent = true;
            inputEl.disabled = true;
            submitBtn.disabled = true;
            if (isFirebaseEnabled && myPlayerKey) {
                await set(ref(database, `sessions/${currentSessionPin}/answers/${myPlayerKey}`), { textAnswer: typedAns, elapsedTime: Date.now() - currentQuestionStartTime });
                document.getElementById("player-waiting-msg").classList.remove("hidden");
            }
        };
    } else if (qType === "number-guess") {
        document.getElementById("player-input-number").classList.remove("hidden");
        const rangeEl = document.getElementById("input-number-guess");
        const displayEl = document.getElementById("display-number-guess");
        const submitBtn = document.getElementById("btn-submit-number-guess");
        
        rangeEl.value = 50;
        displayEl.innerText = 50;
        rangeEl.disabled = false;
        submitBtn.disabled = false;
        
        rangeEl.oninput = (e) => {
            displayEl.innerText = e.target.value;
        };
        
        submitBtn.onclick = async () => {
            if (hasAnsweredCurrent) return;
            hasAnsweredCurrent = true;
            rangeEl.disabled = true;
            submitBtn.disabled = true;
            if (isFirebaseEnabled && myPlayerKey) {
                await set(ref(database, `sessions/${currentSessionPin}/answers/${myPlayerKey}`), { numberAnswer: parseFloat(rangeEl.value), elapsedTime: Date.now() - currentQuestionStartTime });
                document.getElementById("player-waiting-msg").classList.remove("hidden");
            }
        };
    } else if (qType === "poll") {
        document.getElementById("player-input-poll").classList.remove("hidden");
        const pollContainer = document.getElementById("player-poll-options");
        pollContainer.innerHTML = "";
        const options = session.questionOptions || [];
        options.forEach((opt, idx) => {
            const btn = document.createElement("button");
            btn.className = "btn btn-secondary w-full text-left flex items-center gap-3";
            btn.style.fontSize = "1.1rem";
            btn.style.padding = "0.75rem 1.25rem";
            btn.style.marginBottom = "0.5rem";
            btn.innerHTML = `<span style="font-weight:bold; color:var(--color-cyan)">${String.fromCharCode(65 + idx)}</span> <span>${opt}</span>`;
            btn.onclick = async () => {
                if (hasAnsweredCurrent) return;
                hasAnsweredCurrent = true;
                const btns = pollContainer.querySelectorAll("button");
                btns.forEach(b => {
                    b.disabled = true;
                    if (b !== btn) b.style.opacity = "0.5";
                });
                btn.style.borderColor = "var(--color-cyan)";
                if (isFirebaseEnabled && myPlayerKey) {
                    await set(ref(database, `sessions/${currentSessionPin}/answers/${myPlayerKey}`), { optionIndex: idx, elapsedTime: Date.now() - currentQuestionStartTime });
                    document.getElementById("player-waiting-msg").classList.remove("hidden");
                }
            };
            pollContainer.appendChild(btn);
        });
    } else if (qType === "speed-math") {
        document.getElementById("player-input-speedmath").classList.remove("hidden");
        const inputEl = document.getElementById("input-speedmath-answer");
        const submitBtn = document.getElementById("btn-submit-speedmath");
        inputEl.value = "";
        inputEl.disabled = false;
        submitBtn.disabled = false;
        
        submitBtn.onclick = async () => {
            if (hasAnsweredCurrent) return;
            const val = inputEl.value.trim();
            if (!val) return;
            hasAnsweredCurrent = true;
            inputEl.disabled = true;
            submitBtn.disabled = true;
            if (isFirebaseEnabled && myPlayerKey) {
                await set(ref(database, `sessions/${currentSessionPin}/answers/${myPlayerKey}`), { textAnswer: val, elapsedTime: Date.now() - currentQuestionStartTime });
                document.getElementById("player-waiting-msg").classList.remove("hidden");
            }
        };
    }
}

function renderPlayerJumbledPrompt(words) {
    const availableContainer = document.getElementById("player-jumbled-available");
    const constructedContainer = document.getElementById("player-jumbled-constructed");
    
    availableContainer.innerHTML = "";
    constructedContainer.innerHTML = "";
    
    let constructedSequence = [];
    const scrambled = [...words].sort(() => Math.random() - 0.5);
    
    const checkSubmission = async () => {
        if (constructedSequence.length === words.length) {
            hasAnsweredCurrent = true;
            const chips = document.querySelectorAll(".player-jumbled-chip");
            chips.forEach(c => c.style.pointerEvents = "none");
            if (isFirebaseEnabled && myPlayerKey) {
                await set(ref(database, `sessions/${currentSessionPin}/answers/${myPlayerKey}`), { sequence: constructedSequence, elapsedTime: Date.now() - currentQuestionStartTime });
                document.getElementById("player-waiting-msg").classList.remove("hidden");
            }
        }
    };

    scrambled.forEach((w, index) => {
        const chip = document.createElement("div");
        chip.className = "player-jumbled-chip";
        chip.innerText = w;
        chip.onclick = () => {
            if (hasAnsweredCurrent) return;
            chip.remove();
            constructedContainer.appendChild(chip);
            constructedSequence.push(w);
            chip.onclick = () => {
                if (hasAnsweredCurrent) return;
                chip.remove();
                availableContainer.appendChild(chip);
                constructedSequence = constructedSequence.filter(item => item !== w);
                chip.onclick = () => {
                    if (hasAnsweredCurrent) return;
                    chip.remove();
                    constructedContainer.appendChild(chip);
                    constructedSequence.push(w);
                    checkSubmission();
                };
            };
            checkSubmission();
        };
        availableContainer.appendChild(chip);
    });
}

async function renderPlayerResultPanel(session) {
    hasAnsweredCurrent = false;
    if (!isFirebaseEnabled || !myPlayerKey) { switchView("playerResult"); return; }

    try {
        const pSnap = await get(ref(database, `sessions/${currentSessionPin}/players/${myPlayerKey}`));
        const allPlayersSnap = await get(ref(database, `sessions/${currentSessionPin}/players`));
        if (!pSnap.exists() || !allPlayersSnap.exists()) return;

        const pData = pSnap.val();
        currentScore = pData.score;
        currentStreak = pData.streak;

        const titleUI = document.getElementById("player-result-title");
        const panel = document.getElementById("player-result-panel");
        const pointsBadge = document.getElementById("player-points-earned");
        const streakMsg = document.getElementById("player-result-streak-msg");

        panel.classList.remove("result-correct", "result-incorrect");

        const qType = session.questionType || "multiple-choice";
        if (qType === "poll") {
            titleUI.innerText = "Opinion Recorded! 📊";
            panel.classList.add("result-correct");
            pointsBadge.innerText = "0";
        } else {
            if (pData.wasCorrect) {
                titleUI.innerText = qType === "speed-math" ? "Math Master! ⚡" : "Correct Option!";
                panel.classList.add("result-correct");
                pointsBadge.innerText = pData.lastPointsEarned;
                try { sfx.powerup.play(); } catch (e) { }
            } else {
                titleUI.innerText = qType === "speed-math" ? "Too Slow or Wrong! ⚡" : "Incorrect Option.";
                panel.classList.add("result-incorrect");
                pointsBadge.innerText = "0";
            }
        }

        if (currentStreak >= 3) {
            streakMsg.classList.remove("hidden");
            document.getElementById("player-streak-badge").classList.remove("hidden");
            document.getElementById("player-streak-count").innerText = currentStreak;
        } else {
            streakMsg.classList.add("hidden");
            if (currentStreak === 0) document.getElementById("player-streak-badge").classList.add("hidden");
        }

        const sortedPool = Object.entries(allPlayersSnap.val()).map(([k, v]) => ({ key: k, score: v.score })).sort((a, b) => b.score - a.score);
        const currentRank = sortedPool.findIndex(item => item.key === myPlayerKey) + 1;

        document.getElementById("player-rank-number").innerText = currentRank;
        document.getElementById("player-rank-total").innerText = sortedPool.length;
        document.getElementById("player-total-score").innerText = currentScore;

        const movementUI = document.getElementById("player-rank-movement");
        movementUI.classList.remove("up", "down", "same");

        if (previousRank === null || currentRank === previousRank) {
            movementUI.innerText = "— Stable"; movementUI.classList.add("same");
        } else if (currentRank < previousRank) {
            movementUI.innerText = `▲ Up ${previousRank - currentRank} Position(s)`; movementUI.classList.add("up");
        } else {
            movementUI.innerText = `▼ Down ${currentRank - previousRank} Position(s)`; movementUI.classList.add("down");
        }

        previousRank = currentRank;
        switchView("playerResult");
    } catch (err) { console.error(err); }
}

function listUIFinalLeaderboard(session) {
    const listUI = document.getElementById("player-lb-list");
    listUI.innerHTML = "";
    document.getElementById("player-lb-msg").innerText = "Match concluded! Evaluation complete.";
    switchView("playerLeaderboard");
}

// ==========================================
// 7. MULTICAST RX EMISSIONS
// ==========================================
function setupPlayerReactionPipelines() {
    const triggerInboundReaction = async (emojiChar) => {
        if (emojiCooldownActive || !currentSessionPin) return;
        emojiCooldownActive = true;
        const targetButtons = document.querySelectorAll(".btn-emoji");
        targetButtons.forEach(b => b.classList.add("on-cooldown"));

        if (isFirebaseEnabled) {
            await set(push(ref(database, `sessions/${currentSessionPin}/reactions`)), { emoji: emojiChar, origin: myNickname, timestamp: Date.now() });
        }
        setTimeout(() => {
            emojiCooldownActive = false;
            targetButtons.forEach(b => b.classList.remove("on-cooldown"));
        }, 800);
    };

    document.querySelectorAll(".btn-emoji").forEach(btn => {
        btn.addEventListener("click", (e) => triggerInboundReaction(e.currentTarget.getAttribute("data-emoji")));
    });
}

function spawnReactionOnHostScreen(emojiChar) {
    let container = document.getElementById("host-lobby-emoji-container");
    if (views.hostLeaderboard.classList.contains("active")) container = document.getElementById("host-emoji-container");
    if (!container) return;

    const el = document.createElement("div");
    el.className = "floating-emoji";
    el.innerText = emojiChar;
    el.style.left = `${Math.random() * 85 + 5}%`;
    container.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
}

// ==========================================
// 8. PREVIEW MODAL ENGINE
// ==========================================
function compileQuestionFromBlock(block) {
    const qType = block.getAttribute("data-qtype");
    const qText = (block.querySelector(".maker-q-text")?.value || "").trim() || "Example Question?";
    const qTime = parseInt(block.querySelector(".maker-q-time")?.value) || 20;
    const qImage = block.getAttribute("data-image") || "";
    const qObj = { type: qType, text: qText, timeLimit: qTime, image: qImage };

    if (qType === "multiple-choice") {
        const opts = Array.from(block.querySelectorAll(".maker-q-opt")).map(i => i.value.trim());
        const checkedRadio = block.querySelector(".maker-q-correct:checked");
        const correctIdx = checkedRadio ? parseInt(checkedRadio.value) : 0;
        qObj.options = opts.map((o, i) => o || `Option ${i+1}`);
        qObj.correct = correctIdx;
    } else if (qType === "true-false") {
        qObj.options = ["True", "False"]; qObj.correct = 0;
    } else if (qType === "jumbled-prompt") {
        const words = (block.querySelector(".maker-q-words")?.value || "").split(",").map(w => w.trim()).filter(w => w);
        qObj.words = words.length > 0 ? words : ["Example", "jumbled", "prompt"];
    } else if (qType === "type-answer") {
        qObj.answerText = block.querySelector(".maker-q-answer")?.value.trim() || "Answer";
    } else if (qType === "number-guess") {
        qObj.targetNumber = parseInt(block.querySelector(".maker-q-number")?.value) || 50;
    } else if (qType === "poll") {
        const opts = (block.querySelector(".maker-q-poll-opts")?.value || "").split(",").map(o => o.trim()).filter(o => o);
        qObj.options = opts.length > 0 ? opts : ["Option A", "Option B"]; qObj.isPoll = true;
    } else if (qType === "speed-math") {
        qObj.equation = block.querySelector(".maker-q-math-eq")?.value.trim() || "2 + 2"; 
        qObj.answerNumber = parseInt(block.querySelector(".maker-q-math-ans")?.value) || 4;
    }
    return qObj;
}

let previewQuestions = [];
let currentPreviewIndex = 0;

function showPreviewModal(questions, startIndex = 0) {
    previewQuestions = questions;
    currentPreviewIndex = startIndex;
    renderPreviewQuestion();
    document.getElementById("preview-modal").classList.remove("hidden");
}

function renderPreviewQuestion() {
    const q = previewQuestions[currentPreviewIndex];
    if (!q) return;

    document.getElementById("preview-question-text").innerText = q.text;
    document.getElementById("preview-timer").innerText = q.timeLimit;
    
    const imgContainer = document.getElementById("preview-question-image-container");
    const imgEl = document.getElementById("preview-question-image");
    if (q.image) {
        imgEl.src = q.image;
        imgContainer.classList.remove("hidden");
    } else {
        imgEl.src = "";
        imgContainer.classList.add("hidden");
    }
    
    const mc = document.getElementById("preview-ans-mc");
    const tf = document.getElementById("preview-ans-tf");
    const jumbled = document.getElementById("preview-ans-jumbled");
    const text = document.getElementById("preview-ans-text");
    const number = document.getElementById("preview-ans-number");
    const poll = document.getElementById("preview-ans-poll");
    const speedmath = document.getElementById("preview-ans-speedmath");
    
    if(mc) mc.classList.add("hidden"); if(tf) tf.classList.add("hidden");
    if(jumbled) jumbled.classList.add("hidden"); if(text) text.classList.add("hidden");
    if(number) number.classList.add("hidden"); if(poll) poll.classList.add("hidden"); if(speedmath) speedmath.classList.add("hidden");

    if (!q.type || q.type === "multiple-choice") {
        if(mc) mc.classList.remove("hidden");
        document.getElementById("preview-ans-0").innerText = q.options[0] || "";
        document.getElementById("preview-ans-1").innerText = q.options[1] || "";
        document.getElementById("preview-ans-2").innerText = q.options[2] || "";
        document.getElementById("preview-ans-3").innerText = q.options[3] || "";
    } else if (q.type === "true-false") {
        if(tf) tf.classList.remove("hidden");
        document.getElementById("preview-ans-tf-0").innerText = q.options[0] || "True";
        document.getElementById("preview-ans-tf-1").innerText = q.options[1] || "False";
    } else if (q.type === "jumbled-prompt") {
        if(jumbled) jumbled.classList.remove("hidden");
        const container = document.getElementById("preview-jumbled-words");
        if(container) {
            container.innerHTML = "";
            const scrambled = [...q.words].sort(() => Math.random() - 0.5);
            scrambled.forEach(w => {
                const span = document.createElement("span"); span.className = "jumbled-word-chip"; span.innerText = w;
                container.appendChild(span);
            });
        }
    } else if (q.type === "type-answer") {
        if(text) text.classList.remove("hidden");
    } else if (q.type === "number-guess") {
        if(number) number.classList.remove("hidden");
    } else if (q.type === "poll") {
        if(poll) poll.classList.remove("hidden");
    } else if (q.type === "speed-math") {
        if(speedmath) speedmath.classList.remove("hidden");
        const eqDisp = document.getElementById("preview-math-equation-display");
        if(eqDisp) eqDisp.innerText = q.equation || "?";
    }

    const nav = document.getElementById("preview-nav-controls");
    if (previewQuestions.length > 1) {
        nav.classList.remove("hidden");
        document.getElementById("preview-counter").innerText = `${currentPreviewIndex + 1} / ${previewQuestions.length}`;
        document.getElementById("btn-preview-prev").disabled = currentPreviewIndex === 0;
        document.getElementById("btn-preview-next").disabled = currentPreviewIndex === previewQuestions.length - 1;
    } else {
        nav.classList.add("hidden");
    }
}

// Attach modal event listeners directly (module is deferred, DOM is ready)
document.getElementById("btn-close-preview")?.addEventListener("click", () => {
    document.getElementById("preview-modal").classList.add("hidden");
});
document.getElementById("btn-preview-prev")?.addEventListener("click", () => {
    if (currentPreviewIndex > 0) { currentPreviewIndex--; renderPreviewQuestion(); }
});
document.getElementById("btn-preview-next")?.addEventListener("click", () => {
    if (currentPreviewIndex < previewQuestions.length - 1) { currentPreviewIndex++; renderPreviewQuestion(); }
});