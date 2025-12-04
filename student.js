import { auth, db, provider } from './config.js';
import { signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, getDocs, doc, getDoc, addDoc, query, where, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// --- STATE ---
let currentUser = null;
let currentExam = null;
let userAnswers = {};      
let questionStatus = {};   
let timeLog = {};          
let currentQIdx = 0;
let lastTimeRef = 0;
let timerInterval;
let liveDocId = null;

// Analysis State
let currentAnalysisData = null;
let currentTestSchema = null;
let currentSolIdx = 0;

// Store mapping from flat index to original question/sub-question
let flatQuestions = [];
let flatToOriginal = [];

let analysisFlatQuestions = [];
let analysisFlatToOriginal = [];

// --- DOM ELEMENTS & VIEWS ---
const views = {
    auth: document.getElementById('auth-view'),
    dash: document.getElementById('dashboard-view'),
    exam: document.getElementById('exam-view'),
    anOverview: document.getElementById('analysis-overview'),
    anDetail: document.getElementById('analysis-detail')
};

function switchView(viewName) {
    Object.values(views).forEach(v => v.classList.add('hidden'));
    views[viewName].classList.remove('hidden');
}

// --- AUTH ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        switchView('dash');
        document.getElementById('user-name-display').innerText = user.displayName;
        loadDashboard();
    } else {
        switchView('auth');
    }
});

document.getElementById('login-btn').onclick = () => signInWithPopup(auth, provider);
document.getElementById('logout-btn').onclick = () => signOut(auth).then(() => location.reload());

// Toggle sidebar in exam view
document.getElementById('toggle-sidebar').onclick = () => {
    const sidebar = document.getElementById('palette');
    sidebar.classList.toggle('collapsed');
};

// --- DASHBOARD ---
async function loadDashboard() {
    const list = document.getElementById('exam-list');
    const hist = document.getElementById('history-list');
    list.innerHTML = 'Loading...';

    try {
        // 1. Fetch Data
        const testsSnap = await getDocs(collection(db, "tests"));
        const resultsSnap = await getDocs(query(collection(db, "results"), where("uid", "==", currentUser.uid)));
        
        // 2. Group Results by Test ID
        const attemptsMap = {}; // { testId: [result1, result2] }
        resultsSnap.forEach(doc => {
            const data = doc.data();
            data.id = doc.id; // Store Doc ID for analysis link
            if (!attemptsMap[data.testId]) attemptsMap[data.testId] = [];
            attemptsMap[data.testId].push(data);
        });

        // 3. Render Exam List
        list.innerHTML = '';
        testsSnap.forEach(d => {
            const t = d.data();
            const myAttempts = attemptsMap[d.id] || [];
            const attemptCount = myAttempts.length;
            const maxAttempts = t.attemptsAllowed || 1;
            
            // Skip disabled exams if student has not attempted yet
            if (t.disabled && attemptCount === 0) {
                return; // Don't show this exam
            }
            
            // Sort attempts by date (newest first) to get latest result for analysis
            myAttempts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            const latestResult = myAttempts[0];

            let footerHTML = '';
            let statusBadge = '';

            if (attemptCount === 0) {
                // Not Attempted
                statusBadge = `<span style="color:var(--gray); font-size:0.8rem">● New</span>`;
                footerHTML = `<button class="btn btn-primary" style="width:100%" onclick="window.initExam('${d.id}')">Start Exam</button>`;
            } else {
                // Attempted at least once
                const isLimitReached = attemptCount >= maxAttempts;
                
                // Button 1: Analysis (Always available if attempted)
                const analysisBtn = `<button class="btn btn-success" style="flex:1" onclick="window.loadAnalysis('${latestResult.id}')">Analysis</button>`;
                
                // Button 2: Retake (If limit not reached)
                let retakeBtn = '';
                if (!isLimitReached) {
                    retakeBtn = `<button class="btn btn-outline" style="flex:1" onclick="window.initExam('${d.id}')">Retake</button>`;
                } else {
                    retakeBtn = `<button class="btn btn-outline" style="flex:1" disabled title="Max attempts reached">Limit Reached</button>`;
                }

                statusBadge = `<span style="color:var(--success); font-weight:bold; font-size:0.8rem">● Attempt ${attemptCount}/${maxAttempts}</span>`;
                footerHTML = `<div style="display:flex; gap:10px; width:100%">${analysisBtn}${retakeBtn}</div>`;
            }

            // Assuming 'exam' is your exam object from Firestore
            const expiryText = t.expiryDate ? `<div class="expiry-date">Expiry: ${new Date(t.expiryDate).toLocaleString()}</div>` : '';

            list.innerHTML += `
                <div class="dash-card">
                    <div style="display:flex; justify-content:space-between">
                        <h3>${t.title}</h3>
                        ${statusBadge}
                    </div>
                    <div class="dash-info">
                        <span><i class="fa fa-clock"></i> ${t.duration} m</span>
                        <span><i class="fa fa-list"></i> ${t.questions.length} Qs</span>
                    </div>
                    ${footerHTML}
                    ${expiryText}
                </div>`;
        });

        // 4. Render History (Flat list of all attempts)
        hist.innerHTML = '';
        // Sort all results by timestamp descending
        const allResults = [];
        resultsSnap.forEach(d => {
             const data = d.data();
             data.id = d.id;
             allResults.push(data);
        });
        allResults.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));

        allResults.forEach(r => {
            hist.innerHTML += `
                <div class="dash-card" style="border-left:4px solid var(--primary); cursor:pointer" onclick="window.loadAnalysis('${r.id}')">
                    <h4>${r.examTitle || 'Exam'}</h4>
                    <div style="display:flex; justify-content:space-between; margin-top:10px">
                        <span>Score: <b>${r.score}</b></span>
                        <small>${new Date(r.timestamp).toLocaleDateString()}</small>
                    </div>
                </div>`;
        });

    } catch (e) { console.error(e); }
}

// --- EXAM ENGINE ---
window.initExam = async (tid) => {
    try {
        // 1. Fetch Exam
        const docSnap = await getDoc(doc(db, "tests", tid));
        if(!docSnap.exists()) { alert("Exam not found"); return; }
        
        currentExam = docSnap.data();
        currentExam.id = tid;

        // 2. SECURITY CHECK: Check attempts again before starting
        const resSnap = await getDocs(query(collection(db, "results"), where("uid", "==", currentUser.uid), where("testId", "==", tid)));
        const max = currentExam.attemptsAllowed || 1;
        if(resSnap.size >= max) {
            alert(`You have already used all ${max} attempts for this exam.`);
            location.reload();
            return;
        }

        // 3. Flatten questions for navigation
        flattenQuestions(currentExam.questions);

        // 4. Init State
        userAnswers = {};
        questionStatus = {};
        timeLog = {};
        for (let i = 0; i < flatQuestions.length; i++) {
            questionStatus[i] = 'not-visited';
            timeLog[i] = 0;
        }

        // 5. Set Live Status
        try {
            const liveRef = await addDoc(collection(db, "live_status"), {
                uid: currentUser.uid, name: currentUser.displayName, testId: tid, status: "Active", lastActive: new Date().toISOString()
            });
            liveDocId = liveRef.id;
        } catch(e) {}

        // 6. Start UI
        switchView('exam');
        document.body.classList.add('exam-mode');
        try { await document.documentElement.requestFullscreen(); } catch(e){}

        // Set exam title in header
        document.getElementById('exam-title').innerText = currentExam.title || 'Exam';

        renderPalette();
        lastTimeRef = Date.now();
        loadQuestion(0);
        startTimer(currentExam.duration * 60);

    } catch (err) { alert("Error: " + err.message); }
};

// --- Question Loading ---
window.loadQuestion = (idx) => {
    const now = Date.now();
    timeLog[currentQIdx] += (now - lastTimeRef) / 1000;
    lastTimeRef = now;

    if (questionStatus[currentQIdx] === 'not-visited') questionStatus[currentQIdx] = 'not-answered';
    updatePaletteNode(currentQIdx);

    currentQIdx = idx;
    const q = flatQuestions[idx];
    const area = document.getElementById('q-area');

    // Initialize tempAnswer with saved answer for this question
    tempAnswer = userAnswers[idx] !== undefined ? JSON.parse(JSON.stringify(userAnswers[idx])) : null;

    let imgHTML = q.img ? `<img src="${q.img}" class="q-img" onerror="this.style.display='none'">` : '';
    let marks = `(+${q.pos || q.marks || 4}, -${q.neg || q.negativeMarks || 1})`;

    let questionText = q.question || q.text || '';
    let inputHTML = '';

    // Show passage above sub-question if present
    if (q.passage) {
        inputHTML += `<div class="passage">${q.passage}</div>`;
    }

    // Prepare local (unsaved) answer state
    let localAns = tempAnswer;

    if (q.type === 'single') {
        inputHTML += `<div class="options-grid">`;
        q.options.forEach((opt, i) => {
            let sel = localAns == i ? 'selected' : '';
            let chk = localAns == i ? 'checked' : '';
            inputHTML += `
                <label class="option-box ${sel}" id="opt-${i}" onclick="setTempOption(${i})">
                    <input type="radio" name="ans" ${chk}> 
                    <div>${opt}</div>
                </label>`;
        });
        inputHTML += `</div>`;
    } else if (q.type === 'multi') {
        inputHTML += `<div class="options-grid">`;
        let arr = Array.isArray(localAns) ? localAns : [];
        q.options.forEach((opt, i) => {
            let sel = arr.includes(i) ? 'selected' : '';
            let chk = arr.includes(i) ? 'checked' : '';
            inputHTML += `
                <label class="option-box ${sel}" id="opt-${i}" onclick="setTempMultiOption(${i})">
                    <input type="checkbox" name="ans" ${chk}> 
                    <div>${opt}</div>
                </label>`;
        });
        inputHTML += `</div>`;
    } else if (q.type === 'integer' || q.type === 'numerical') {
        inputHTML += `<input type="number" class="form-control" style="width:100%; padding:15px; font-size:1.2rem; border:2px solid #ccc; border-radius:6px;" placeholder="Answer" value="${localAns||''}" oninput="setTempInt(this.value)">`;
    } else if (q.type === 'matrix') {
        // Defensive: Ensure rows and columns exist and are arrays
        if (!Array.isArray(q.rows) || !Array.isArray(q.columns)) {
            inputHTML += `<div style="color:red;">Matrix question data is missing rows or columns.</div>`;
        } else {
            // Always initialize localAns as an array of arrays for matrix questions
            if (!Array.isArray(localAns) || localAns.length !== q.rows.length) {
                localAns = [];
                for (let i = 0; i < q.rows.length; i++) localAns[i] = [];
                // Also update tempAnswer and userAnswers to keep state in sync
                tempAnswer = localAns;
                userAnswers[idx] = localAns;
            }
            let legend = `<div class="matrix-legend"><b>Rows:</b> ${q.rows.join(', ')}<br><b>Columns:</b> ${q.columns.join(', ')}</div>`;
            inputHTML += legend + `<table class="matrix-table"><tr><th></th>`;
            q.columns.forEach((col, j) => {
                inputHTML += `<th>${col}</th>`;
            });
            inputHTML += `</tr>`;
            q.rows.forEach((row, i) => {
                inputHTML += `<tr><td>${row}</td>`;
                q.columns.forEach((col, j) => {
                    let checked = Array.isArray(localAns[i]) && localAns[i].includes(j) ? 'checked' : '';
                    inputHTML += `<td><input type="checkbox" name="matrix-${i}" value="${j}" ${checked} onclick="setTempMatrix(${i},${j},this.checked)"></td>`;
                });
                inputHTML += `</tr>`;
            });
            inputHTML += `</table>`;

            // Show matches as options (for reference)
            if (Array.isArray(q.matches)) {
                inputHTML += `<div class="matrix-matches" style="margin-top:10px;"><b>Correct Matches (for reference):</b><ul style="margin:0; padding-left:18px;">`;
                q.matches.forEach(m => {
                    const rowLabel = q.rows[m.row] || `Row ${m.row+1}`;
                    const colLabels = (m.cols || []).map(idx => q.columns[idx]).join(', ');
                    inputHTML += `<li>${rowLabel} → ${colLabels}</li>`;
                });
                inputHTML += `</ul></div>`;
            }
        }
    }

    area.innerHTML = `
        <div class="question-card">
            <div class="q-meta"><span>Q${idx+1} (${q.type})</span><span>Marks: ${marks}</span></div>
            ${imgHTML}
            <div class="q-text">${questionText}</div>
            ${inputHTML}
            <div style="margin-top:30px; display:flex; justify-content:space-between; border-top:1px solid #eee; padding-top:20px;">
                <div style="display:flex; gap:10px;">
                    <button class="btn btn-outline" onclick="saveNext()">Save & Next</button>
                    <button class="btn btn-outline" style="border-color:var(--warning)" onclick="markRev()">Mark Review</button>
                    <button class="btn btn-outline" onclick="clearResp()">Clear</button>
                </div>
                <button class="btn btn-primary" onclick="loadQuestion(${idx < flatQuestions.length-1 ? idx+1 : idx})">Next ></button>
            </div>
        </div>`;

    updatePaletteNode(idx);
    if(window.MathJax) MathJax.typesetPromise();
};

// Temporary answer state for current question
let tempAnswer = null;

// Option selection handlers (do not re-render immediately)
window.setTempOption = (i) => {
    tempAnswer = i;
    userAnswers[currentQIdx] = i;
    // Update UI selection
    document.querySelectorAll('.option-box').forEach(e => e.classList.remove('selected'));
    const opt = document.getElementById(`opt-${i}`);
    if (opt) opt.classList.add('selected');
};

window.setTempMultiOption = (i) => {
    if (!Array.isArray(tempAnswer)) tempAnswer = [];
    const idx = tempAnswer.indexOf(i);
    if (idx === -1) tempAnswer.push(i);
    else tempAnswer.splice(idx, 1);

    // Always update userAnswers immediately
    userAnswers[currentQIdx] = [...tempAnswer];

    // Update UI selection (both class and checkbox state)
    document.querySelectorAll('.option-box').forEach((e, j) => {
        const checkbox = e.querySelector('input[type="checkbox"]');
        if (tempAnswer.includes(j)) {
            e.classList.add('selected');
            if (checkbox) checkbox.checked = true;
        } else {
            e.classList.remove('selected');
            if (checkbox) checkbox.checked = false;
        }
    });
};

window.setTempInt = (v) => {
    tempAnswer = v;
    userAnswers[currentQIdx] = v;
};

// Save & Next
window.saveNext = () => {
    // Save a deep copy to avoid mutation issues
    if (Array.isArray(tempAnswer)) {
        userAnswers[currentQIdx] = [...tempAnswer];
    } else {
        userAnswers[currentQIdx] = tempAnswer;
    }

    let q = flatQuestions[currentQIdx];
    let isAnswered = false;
    if (q.type === 'multi') {
        isAnswered = Array.isArray(tempAnswer) && tempAnswer.length > 0;
    } else if (q.type === 'numerical' || q.type === 'integer') {
        isAnswered = tempAnswer !== undefined && tempAnswer !== null && tempAnswer !== '';
    } else {
        isAnswered = tempAnswer !== undefined && tempAnswer !== null && tempAnswer !== '';
    }
    questionStatus[currentQIdx] = isAnswered ? 'answered' : 'not-answered';
    updatePaletteNode(currentQIdx);
    if(currentQIdx < flatQuestions.length-1) loadQuestion(currentQIdx+1);
};

// Mark Review
window.markRev = () => {
    if (Array.isArray(tempAnswer)) {
        userAnswers[currentQIdx] = [...tempAnswer];
    } else {
        userAnswers[currentQIdx] = tempAnswer;
    }

    let q = flatQuestions[currentQIdx];
    let isAnswered = false;
    if (q.type === 'multi') {
        isAnswered = Array.isArray(tempAnswer) && tempAnswer.length > 0;
    } else if (q.type === 'numerical' || q.type === 'integer') {
        isAnswered = tempAnswer !== undefined && tempAnswer !== null && tempAnswer !== '';
    } else {
        isAnswered = tempAnswer !== undefined && tempAnswer !== null && tempAnswer !== '';
    }
    questionStatus[currentQIdx] = isAnswered ? 'marked-answered' : 'marked';
    updatePaletteNode(currentQIdx);
    if(currentQIdx < flatQuestions.length-1) loadQuestion(currentQIdx+1);
};

// Clear
window.clearResp = () => {
    tempAnswer = null;
    delete userAnswers[currentQIdx];
    questionStatus[currentQIdx] = 'not-answered';
    updatePaletteNode(currentQIdx);
    loadQuestion(currentQIdx);
};

// Define your palette colors
const paletteColors = {
    'answered': 'var(--success)',        // green
    'not-answered': 'var(--danger)',     // red
    'marked': 'var(--purple)',           // purple
    'marked-answered': 'var(--purple)',  // purple (can be different if you want)
    'not-visited': '#ccc',               // gray
    'current': 'var(--primary)'          // blue (for current question border)
};

// Helper to get all statuses for a question
function getStatuses(i) {
    // You can expand this logic if you want to support more than one status per question
    // For now, let's assume you want to show both 'answered' and 'marked' if marked-answered
    const status = questionStatus[i];
    if (status === 'marked-answered') return ['answered', 'marked'];
    if (status === 'answered') return ['answered'];
    if (status === 'marked') return ['marked'];
    if (status === 'not-answered') return ['not-answered'];
    if (status === 'not-visited') return ['not-visited'];
    return [];
}

// Render the palette with pie chart backgrounds
function renderPalette() {
    const p = document.getElementById('palette');
    p.innerHTML = `
        <div class="palette-header">
            <strong>${currentUser.displayName}</strong>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:5px; font-size:0.75rem; margin-top:10px; color:#666;">
                <div><span style="color:var(--success)">●</span> Ans</div>
                <div><span style="color:var(--danger)">●</span> No Ans</div>
                <div><span style="color:var(--purple)">●</span> Mark</div>
                <div><span>○</span> Visit</div>
            </div>
        </div>
        <div class="palette-grid" id="p-grid"></div>`;
    const grid = document.getElementById('p-grid');
    for (let i = 0; i < flatQuestions.length; i++) {
        const d = document.createElement('div');
        d.className = 'q-node';
        d.id = `node-${i}`;
        d.innerText = i+1;
        d.onclick = () => loadQuestion(i);

        // Set pie chart background
        const statuses = getStatuses(i);
        if (statuses.length > 1) {
            // Pie chart: split equally among statuses
            const step = 100 / statuses.length;
            let stops = [];
            for (let j = 0; j < statuses.length; j++) {
                const color = paletteColors[statuses[j]];
                stops.push(`${color} ${j*step}% ${(j+1)*step}%`);
            }
            d.style.background = `conic-gradient(${stops.join(', ')})`;
        } else if (statuses.length === 1) {
            d.style.background = paletteColors[statuses[0]];
        } else {
            d.style.background = '#ccc';
        }

        // Highlight current question
        if(i === currentQIdx) d.style.border = `2px solid ${paletteColors.current}`;
        else d.style.border = '2px solid #fff';

        grid.appendChild(d);
    }
}

// Update a single palette node (for dynamic updates)
function updatePaletteNode(i) {
    const n = document.getElementById(`node-${i}`);
    if(n) {
        // Remove all classes
        n.className = 'q-node';
        // Set pie chart background
        const statuses = getStatuses(i);
        if (statuses.length > 1) {
            const step = 100 / statuses.length;
            let stops = [];
            for (let j = 0; j < statuses.length; j++) {
                const color = paletteColors[statuses[j]];
                stops.push(`${color} ${j*step}% ${(j+1)*step}%`);
            }
            n.style.background = `conic-gradient(${stops.join(', ')})`;
        } else if (statuses.length === 1) {
            n.style.background = paletteColors[statuses[0]];
        } else {
            n.style.background = '#ccc';
        }
        // Highlight current
        if(i === currentQIdx) n.style.border = `2px solid ${paletteColors.current}`;
        else n.style.border = '2px solid #fff';
    }
}

function startTimer(sec) {
    let rem = sec;
    if(timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        rem--;
        const h = Math.floor(rem/3600); const m = Math.floor((rem%3600)/60); const s = rem%60;
        document.getElementById('timer').innerText = `${h<10?'0'+h:h}:${m<10?'0'+m:m}:${s<10?'0'+s:s}`;
        if(rem < 300) document.getElementById('timer').classList.add('critical');
        if(rem%60===0 && liveDocId) updateDoc(doc(db,"live_status",liveDocId), {lastActive: new Date().toISOString()});
        if(rem<=0) window.submitExam();
    }, 1000);
}

window.submitExam = async () => {
    if(!confirm("Submit Exam?")) return;
    document.getElementById('submit-btn').innerText = "Processing...";
    clearInterval(timerInterval);
    try { document.exitFullscreen().catch(()=>{}); } catch(e){}

    let score = 0;
    let details = [];

    currentExam.questions.forEach((q, i) => {
        let uAns = userAnswers[i];
        // For multi correct, ensure empty array is saved as null
        if (q.type === 'multi' && (!uAns || uAns.length === 0)) uAns = null;
        // For passage, ensure empty object is saved as null
        if (q.type === 'passage' && (!uAns || Object.keys(uAns).length === 0)) uAns = null;
        // For other types, if undefined, set to null
        if (uAns === undefined) uAns = null;

        let marks = 0;
        let isCorrect = false;

        // Scoring logic with JEE Advanced style partial marking for multi-correct
        if (uAns !== null) {
            if (q.type === 'multi' && Array.isArray(uAns) && Array.isArray(q.answer)) {
                // Check if all selected answers are correct (no wrong option selected)
                const allCorrect = uAns.every(v => q.answer.includes(v));
                const allAnswersSelected = uAns.length === q.answer.length && allCorrect;
                
                if (allAnswersSelected) {
                    // Full marks if all correct answers selected
                    marks = parseInt(q.marks || 4);
                    isCorrect = true;
                } else if (allCorrect && uAns.length > 0) {
                    // Partial marks: only correct options selected, but not all
                    // JEE Advanced style: proportional marks based on correct selections
                    const correctCount = uAns.length;
                    const totalCorrect = q.answer.length;
                    marks = parseInt(q.marks || 4) * (correctCount / totalCorrect);
                    isCorrect = false; // Partial credit, not fully correct
                } else {
                    // Wrong answer: at least one wrong option selected or all wrong
                    marks = -parseInt(q.negativeMarks || 1);
                    isCorrect = false;
                }
            } else if (q.type === 'passage' && Array.isArray(q.questions)) {
                // For passage, you may want to store sub-question results
                // Here, just mark as attempted
                marks = 0; // You can sum sub-question marks if needed
            } else if (uAns == (q.answer ?? q.correct)) {
                marks = parseInt(q.marks || 4);
                isCorrect = true;
            } else {
                marks = -parseInt(q.negativeMarks || 1);
            }
        }
        score += marks;
        details.push({
            qIdx: i,
            userAns: uAns,
            correct: q.answer ?? q.correct ?? null,
            isCorrect,
            marks,
            time: timeLog[i] || 0
        });
    });

    try {
        await addDoc(collection(db, "results"), {
            uid: currentUser.uid,
            studentName: currentUser.displayName || 'Student',
            email: currentUser.email || '',
            examTitle: currentExam.title,
            testId: currentExam.id,
            score,
            details,
            totalTimeSpent: Object.values(timeLog).reduce((a, b) => a + b, 0),
            timestamp: new Date().toISOString()
        });
        if (liveDocId) updateDoc(doc(db, "live_status", liveDocId), { status: "Completed" });
        alert(`Submitted! Score: ${score}`);
        location.reload();
    } catch(e) {
        console.error(e);
        alert("Error: " + e.message);
        document.getElementById('submit-btn').innerText = "Submit";
    }
};
document.getElementById('submit-btn').onclick = window.submitExam;

// --- ANALYSIS FUNCTIONS ---
window.loadAnalysis = async (resultId) => {
    try {
        const resSnap = await getDoc(doc(db, "results", resultId));
        currentAnalysisData = resSnap.data();
        
        const testSnap = await getDoc(doc(db, "tests", currentAnalysisData.testId));
        currentTestSchema = testSnap.data();

        // FIX: Flatten analysis questions here!
        flattenAnalysisQuestions(currentTestSchema.questions);

        switchView('anOverview');
        document.getElementById('an-score').innerText = `${currentAnalysisData.score} / ${currentTestSchema.questions.length * 4}`;

        // --- Exact Rank Calculation ---
        // 1. Fetch all results for this test
        const allResultsSnap = await getDocs(query(collection(db, "results"), where("testId", "==", currentAnalysisData.testId)));
        const allResults = [];
        allResultsSnap.forEach(doc => {
            const data = doc.data();
            data.id = doc.id;
            allResults.push(data);
        });

        // 2. Sort by score descending, then by totalTimeSpent ascending (for tie-break)
        allResults.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (a.totalTimeSpent || 0) - (b.totalTimeSpent || 0);
        });

        // 3. Find rank (1-based)
        const myRank = allResults.findIndex(r => r.uid === currentUser.uid && r.timestamp === currentAnalysisData.timestamp) + 1;
        document.getElementById('an-rank').innerText = myRank > 0 ? `# ${myRank}` : 'N/A';

        let correctCount = currentAnalysisData.details.filter(d => d.isCorrect).length;
        let attemptedCount = currentAnalysisData.details.filter(d => d.userAns !== null).length;
        document.getElementById('an-accuracy').innerText = attemptedCount > 0 ? Math.round((correctCount/attemptedCount)*100) + '%' : '0%';

        const grid = document.getElementById('an-grid');
        grid.innerHTML = '';
        currentAnalysisData.details.forEach((d, i) => {
            let className = 'an-skip';
            if(d.userAns !== null) className = d.isCorrect ? 'an-correct' : 'an-wrong';
            grid.innerHTML += `<div class="an-node ${className}" onclick="window.loadSolutionDetail(${i})">${i+1}</div>`;
        });

    } catch(e) { console.error(e); alert("Failed to load analysis"); }
};

window.loadSolutionDetail = (idx) => {
    currentSolIdx = idx;
    switchView('anDetail');
    renderSolution(idx);
};

window.backToAnalysisGrid = () => switchView('anOverview');

function renderSolution(idx) {
    const q = analysisFlatQuestions[idx];
    const detail = currentAnalysisData.details[idx];

    let statusClass = 'status-skip', statusText = 'Skipped';
    if (detail.userAns !== null) {
        if (detail.isCorrect) { statusClass = 'status-correct'; statusText = 'Correct'; }
        else { statusClass = 'status-wrong'; statusText = 'Wrong'; }
    }

    // Get question text
    let questionText = q.question || q.text || '';
    let passageHTML = q.passage ? `<div class="passage">${q.passage}</div>` : '';
    let optionsHTML = '';
    let userAnsHTML = '';
    let correctAnsHTML = '';

    // Helper to get option text
    const getOptTxt = (opt) => typeof opt === 'object' ? (opt.text || '') : opt;

    // Render options and answers for each type
    if (q.type === 'single' || q.type === 'MCQ' || q.type === 'SCQ') {
        optionsHTML = `<div class="options-grid">`;
        q.options.forEach((opt, i) => {
            let txt = getOptTxt(opt);
            let borderStyle = '2px solid #ddd', bgStyle = '#fff';
            if (i == (q.answer ?? q.correct)) { borderStyle = '2px solid var(--success)'; bgStyle = '#e6fffa'; }
            else if (detail.userAns == i && !detail.isCorrect) { borderStyle = '2px solid var(--danger)'; bgStyle = '#fff5f5'; }
            optionsHTML += `
                <div class="option-box" style="border:${borderStyle}; background:${bgStyle}; cursor:default">
                    <div>${txt}</div>
                    ${i == (q.answer ?? q.correct) ? '<i class="fa fa-check" style="color:green; margin-left:auto"></i>' : ''}
                    ${(detail.userAns == i && !detail.isCorrect) ? '<i class="fa fa-times" style="color:red; margin-left:auto"></i>' : ''}
                </div>`;
        });
        optionsHTML += `</div>`;
        userAnsHTML = (detail.userAns !== null) ? `<div><b>Your Answer:</b> ${getOptTxt(q.options[detail.userAns])}</div>` : '';
        correctAnsHTML = `<div><b>Correct Answer:</b> ${getOptTxt(q.options[q.answer ?? q.correct])}</div>`;
    } else if (q.type === 'multi') {
        optionsHTML = `<div class="options-grid">`;
        q.options.forEach((opt, i) => {
            let txt = getOptTxt(opt);
            let isCorrect = Array.isArray(q.answer) && q.answer.includes(i);
            let isUser = Array.isArray(detail.userAns) && detail.userAns.includes(i);
            let borderStyle = '2px solid #ddd', bgStyle = '#fff';
            if (isCorrect) { borderStyle = '2px solid var(--success)'; bgStyle = '#e6fffa'; }
            if (isUser && !isCorrect) { borderStyle = '2px solid var(--danger)'; bgStyle = '#fff5f5'; }
            optionsHTML += `
                <div class="option-box" style="border:${borderStyle}; background:${bgStyle}; cursor:default">
                    <div>${txt}</div>
                    ${isCorrect ? '<i class="fa fa-check" style="color:green; margin-left:auto"></i>' : ''}
                    ${(isUser && !isCorrect) ? '<i class="fa fa-times" style="color:red; margin-left:auto"></i>' : ''}
                </div>`;
        });
        optionsHTML += `</div>`;
        userAnsHTML = (Array.isArray(detail.userAns)) ? `<div><b>Your Answer:</b> ${detail.userAns.map(i => getOptTxt(q.options[i])).join(', ')}</div>` : '';
        correctAnsHTML = (Array.isArray(q.answer)) ? `<div><b>Correct Answer:</b> ${q.answer.map(i => getOptTxt(q.options[i])).join(', ')}</div>` : '';
    } else if (q.type === 'integer' || q.type === 'numerical') {
        userAnsHTML = (detail.userAns !== null) ? `<div><b>Your Answer:</b> ${detail.userAns}</div>` : '';
        correctAnsHTML = `<div><b>Correct Answer:</b> ${q.answer ?? q.correct}</div>`;
    } else if (q.type === 'matrix') {
        let legend = '';
        if (q.rows && q.columns) {
            legend = `<div class="matrix-legend"><b>Rows:</b> ${q.rows.join(', ')}<br><b>Columns:</b> ${q.columns.join(', ')}</div>`;
        }
        optionsHTML = legend + `<table class="matrix-table"><tr><th></th>`;
        q.columns.forEach((col, j) => {
            optionsHTML += `<th>${col}</th>`;
        });
        optionsHTML += `</tr>`;
        // Prepare correct and user answers
        let correct = (q.matches || []);
        let user = Array.isArray(detail.userAns) ? detail.userAns : [];
        q.rows.forEach((row, i) => {
            optionsHTML += `<tr><td>${row}</td>`;
            q.columns.forEach((col, j) => {
                let isCorrect = (correct.find(m => m.row === i) || {cols:[]}).cols.includes(j);
                let isUser = Array.isArray(user[i]) && user[i].includes(j);
                let cell = '';
                if (isCorrect && isUser) cell = '<span style="color:green">&#10004;</span>'; // correct tick
                else if (isCorrect) cell = '<span style="color:green">&#10003;</span>'; // correct only
                else if (isUser) cell = '<span style="color:red">&#10008;</span>'; // user wrong
                optionsHTML += `<td style="text-align:center">${cell}</td>`;
            });
            optionsHTML += `</tr>`;
        });
        optionsHTML += `</table>`;
        // Show user and correct answers as text
        userAnsHTML = `<div><b>Your Matches:</b> ${JSON.stringify(user)}</div>`;
        correctAnsHTML = `<div><b>Correct Matches:</b> ${JSON.stringify(correct)}</div>`;
    }

    document.getElementById('sol-content').innerHTML = `
        <div class="sol-status ${statusClass}">${statusText}</div>
        <div class="q-meta"><span>Q${idx+1}</span><span>Time Spent: ${Math.round(detail.time)}s</span><span style="font-weight:bold; color:${detail.marks >= 0 ? 'var(--success)' : 'var(--danger)'}">Marks: ${detail.marks > 0 ? '+' : ''}${detail.marks}</span></div>
        ${q.img ? `<img src="${q.img}" class="q-img">` : ''}
        ${passageHTML}
        <div class="q-text">${questionText}</div>
        ${optionsHTML}
        ${userAnsHTML}
        ${correctAnsHTML}
        ${q.explanation ? `<div class="explanation-box"><strong>Explanation:</strong><br>${q.explanation}</div>` : ''}
    `;

    document.getElementById('prev-sol-btn').disabled = idx === 0;
    document.getElementById('next-sol-btn').disabled = idx === analysisFlatQuestions.length - 1;
    document.getElementById('prev-sol-btn').onclick = () => renderSolution(idx - 1);
    document.getElementById('next-sol-btn').onclick = () => renderSolution(idx + 1);

    if(window.MathJax) MathJax.typesetPromise();
}

function renderExamCard(exam) {
  const expiryText = exam.expiryDate ? `<div class="expiry-date">Expiry: ${new Date(exam.expiryDate).toLocaleString()}</div>` : '';
  return `
    <div class="exam-card">
      <div class="exam-title">${exam.title}</div>
      ${expiryText}
      <div class="exam-window">Window: ${new Date(exam.startTime).toLocaleString()} - ${new Date(exam.endTime).toLocaleString()}</div>
      <button class="btn btn-primary" onclick="startExam('${exam.id}')">Start</button>
    </div>
  `;
}

function renderQuestion(q, idx) {
  let html = `<div class="q-title"><b>Q${idx+1}.</b> `;
  if (q.type === "passage") {
    html += `<div class="passage">${q.passage}</div>`;
    q.questions.forEach((subq, subIdx) => {
      html += renderQuestion(subq, `${idx+1}.${subIdx+1}`);
    });
    return html + '</div>';
  }
  html += q.question + '</div><div class="q-options">';
  if (q.type === "single") {
    q.options.forEach((opt, i) => {
      html += `<label><input type="radio" name="q${idx}" value="${i}"> ${opt}</label><br>`;
    });
  } else if (q.type === "multi") {
    q.options.forEach((opt, i) => {
      html += `<label><input type="checkbox" name="q${idx}" value="${i}"> ${opt}</label><br>`;
    });
  } else if (q.type === "integer" || q.type === "numerical") {
    html += `<input type="number" name="q${idx}" step="any" class="num-input">`;
  } else if (q.type === "matrix") {
    if (q.rows && q.columns) {
      html = `<div class="matrix-legend"><b>Rows:</b> ${q.rows.join(', ')}<br><b>Columns:</b> ${q.columns.join(', ')}</div>` + html;
    }
    q.options.forEach((opt, i) => {
      html += `<label><input type="radio" name="q${idx}" value="${i}"> ${opt}</label><br>`;
    });
  }
  html += '</div>';
  return html;
}

// Flatten questions for easier navigation and analysis
function flattenQuestions(questions) {
    flatQuestions = [];
    flatToOriginal = [];
    questions.forEach((q, i) => {
        if (q.type === 'passage' && Array.isArray(q.questions)) {
            q.questions.forEach((subq, subIdx) => {
                flatQuestions.push({
                    ...subq,
                    passage: q.passage,
                    parentIdx: i,
                    subIdx: subIdx,
                    type: subq.type || 'single' // default to single if not specified
                });
                flatToOriginal.push({ parent: i, sub: subIdx });
            });
        } else {
            flatQuestions.push(q);
            flatToOriginal.push({ parent: i, sub: null });
        }
    });
}

// Flatten analysis questions for easier navigation in analysis view
function flattenAnalysisQuestions(questions) {
    analysisFlatQuestions = [];
    analysisFlatToOriginal = [];
    questions.forEach((q, i) => {
        if (q.type === 'passage' && Array.isArray(q.questions)) {
            q.questions.forEach((subq, subIdx) => {
                analysisFlatQuestions.push({
                    ...subq,
                    passage: q.passage,
                    parentIdx: i,
                    subIdx: subIdx,
                    type: subq.type || 'single'
                });
                analysisFlatToOriginal.push({ parent: i, sub: subIdx });
            });
        } else {
            analysisFlatQuestions.push(q);
            analysisFlatToOriginal.push({ parent: i, sub: null });
        }
    });
}

// --- On Exam Fetch ---
window.onExamFetch = (exam) => {
    // After currentExam = docSnap.data();
    flattenQuestions(currentExam.questions);
}

// Matrix answer handling
function setTempMatrix(i, j, checked) {
    if (!Array.isArray(tempAnswer)) tempAnswer = [];
    if (!Array.isArray(tempAnswer[i])) tempAnswer[i] = [];
    if (checked) {
        if (!tempAnswer[i].includes(j)) tempAnswer[i].push(j);
    } else {
        tempAnswer[i] = tempAnswer[i].filter(x => x !== j);
    }
}