import { auth, db, provider } from './config.js';
import { signInWithPopup, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, getDocs, doc, getDoc, addDoc, query, where, setDoc, updateDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// STATE
let currentUser = null;
let currentExam = null;
let userAnswers = {};
let liveStatusDocId = null;
let timerInterval;
let seenQuestions = new Set();
let currentIndex = 0;

// AUTH
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        document.getElementById('auth-view').classList.add('hidden');
        document.getElementById('dashboard-view').classList.remove('hidden');
        loadDashboard();
    }
});

document.getElementById('login-btn').onclick = () => signInWithPopup(auth, provider);

// DASHBOARD
async function loadDashboard() {
    const list = document.getElementById('exam-list');
    list.innerHTML = 'Loading...';
    const now = new Date();

    const snap = await getDocs(collection(db, "tests"));
    list.innerHTML = '';

    snap.forEach(d => {
        const data = d.data();
        const start = new Date(data.startTime);
        const end = new Date(data.endTime);

        let btnHtml = '';
        let statusMsg = '';

        if (now < start) {
            statusMsg = `<span style="color:orange">Starts: ${start.toLocaleString()}</span>`;
            btnHtml = `<button class="btn" disabled style="background:#ccc">Upcoming</button>`;
        } else if (now > end) {
            statusMsg = `<span style="color:red">Ended: ${end.toLocaleString()}</span>`;
            btnHtml = `<button class="btn" disabled style="background:#ccc">Expired</button>`;
        } else {
            statusMsg = `<span style="color:green">Live Now! Ends: ${end.toLocaleString()}</span>`;
            btnHtml = `<button class="btn btn-primary" onclick="window.checkAndStart('${d.id}')">Start Exam</button>`;
        }

        const analysisBtn = `<button class="btn" onclick="window.viewAnalysis('${d.id}')">View Analysis</button>`;

        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
            <h3>${data.title}</h3>
            <p>${statusMsg}</p>
            <p>Duration: ${data.duration} mins | Attempts: ${data.attemptsAllowed === 999 ? 'Unlimited' : data.attemptsAllowed}</p>
            <div style="display:flex; gap:8px; margin-top:8px;">
                ${btnHtml}
                ${analysisBtn}
            </div>
        `;
        list.appendChild(card);
    });
}

// CHECK ELIGIBILITY & START
window.checkAndStart = async (testId) => {
    // 1. Check Previous Attempts
    const q = query(collection(db, "results"), where("uid", "==", currentUser.uid), where("testId", "==", testId));
    const snap = await getDocs(q);
    const docSnap = await getDoc(doc(db, "tests", testId));
    const examData = docSnap.data();

    if (snap.size >= examData.attemptsAllowed) {
        alert("You have reached the maximum number of attempts for this exam.");
        return;
    }

    // 2. Register Live Status (Online)
    try {
        const statusRef = await addDoc(collection(db, "live_status"), {
            uid: currentUser.uid,
            name: currentUser.displayName,
            email: currentUser.email,
            testId: testId,
            status: "Taking Exam",
            lastActive: new Date().toISOString()
        });
        liveStatusDocId = statusRef.id;
    } catch(e) { console.error("Status Error", e); }

    // 3. Launch
    startExamEngine(testId, examData);
};

// EXAM ENGINE
async function startExamEngine(id, data) {
    currentExam = data;
    currentExam.id = id;
    userAnswers = {};
    seenQuestions = new Set();
    currentIndex = 0;

    try { await document.documentElement.requestFullscreen(); } catch(e){}

    document.getElementById('exam-name').innerText = data.title || 'Exam';

    document.getElementById('dashboard-view').classList.add('hidden');
    document.getElementById('exam-view').classList.remove('hidden');

    renderPalette();
    loadQuestion(0);
    startTimer(data.duration * 60);

    // Heartbeat (Update "Last Active" every 1 min)
    setInterval(() => {
        if(liveStatusDocId) {
            updateDoc(doc(db, "live_status", liveStatusDocId), { lastActive: new Date().toISOString() });
        }
    }, 60000);
}

// RENDER PALETTE
function renderPalette() {
    const p = document.getElementById('palette');
    p.innerHTML = '';
    const total = currentExam.questions.length;
    for(let i=0;i<total;i++){
        const node = document.createElement('div');
        node.className = 'q-node unanswered';
        node.id = `q-node-${i}`;
        node.setAttribute('role','button');
        node.setAttribute('tabindex','0');
        node.dataset.index = i;
        node.innerText = (i+1);
        node.onclick = () => loadQuestion(i);
        node.onkeydown = (e) => { if(e.key === 'Enter' || e.key === ' ') loadQuestion(i); };
        p.appendChild(node);
    }
    updatePaletteVisuals();
}

function updatePaletteVisuals() {
    const total = currentExam.questions.length;
    let answered = 0;
    currentExam.questions.forEach((_, i) => {
        const node = document.getElementById(`q-node-${i}`);
        if(!node) return;
        node.classList.remove('answered','seen','unanswered','marked','flagged','current');
        if (userAnswers[i] !== undefined) { node.classList.add('answered'); answered++; }
        else if (seenQuestions.has(i)) node.classList.add('seen');
        else node.classList.add('unanswered');
    });
    // current highlight
    const cur = document.getElementById(`q-node-${currentIndex}`);
    if(cur) cur.classList.add('current');

    // progress bar
    const pct = Math.round((answered/total)*100);
    const fill = document.getElementById('palette-fill');
    if(fill) fill.style.width = `${pct}%`;
    const count = document.getElementById('palette-count');
    if(count) count.innerText = `${answered} / ${total}`;
    const percent = document.getElementById('palette-percent');
    if(percent) percent.innerText = `${pct}%`;
}

// LOAD QUESTION
window.loadQuestion = (i) => {
    currentIndex = i;
    seenQuestions.add(i);
    const q = currentExam.questions[i];
    const qArea = document.getElementById('q-area');

    // build options markup that matches CSS (.option, .option-number, .option-text)
    let optionsHtml = '';
    if(q.type === 'MCQ' && Array.isArray(q.options)) {
        optionsHtml = q.options.map((o, idx) => {
            const checked = userAnswers[i] === idx ? 'checked' : '';
            return `
            <label class="option" tabindex="0">
                <input type="radio" name="answer" ${checked} onclick="window.save(${i}, ${idx})">
                <span class="option-number">${String.fromCharCode(65 + idx)}</span>
                <span class="option-text">${o}</span>
            </label>`;
        }).join('');
    } else if (q.type === 'INTEGER') {
        const val = (userAnswers[i] !== undefined) ? userAnswers[i] : '';
        optionsHtml = `<div style="margin-top:12px;"><input type="number" id="int-${i}" value="${val}" onchange="window.save(${i}, this.value)" /></div>`;
    } else {
        optionsHtml = `<div style="margin-top:12px;"><input type="text" id="txt-${i}" value="${userAnswers[i] || ''}" onchange="window.save(${i}, this.value)" /></div>`;
    }

    qArea.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
            <h3 style="margin:0">Q${i+1}: ${q.text}</h3>
            <div style="color:var(--muted); font-size:0.95rem">Marks: ${q.marks || 4}</div>
        </div>
        <div style="margin-top:18px">${optionsHtml}</div>
    `;

    // visual updates for selected option (in case we loaded checked)
    setTimeout(() => { markSelectedOptionUI(i); }, 0);

    updatePaletteVisuals();
};

// SAVE ANSWER
window.save = (i, v) => {
    // normalize numeric string to number for integer types
    if(typeof v === 'string' && currentExam.questions[i] && currentExam.questions[i].type === 'INTEGER') {
        const n = v.trim();
        userAnswers[i] = n === '' ? undefined : (isNaN(Number(n)) ? n : Number(n));
    } else {
        userAnswers[i] = v;
    }

    // mark answered node
    const node = document.getElementById(`q-node-${i}`);
    if(node) {
        node.classList.remove('unanswered','seen');
        node.classList.add('answered');
    }

    // update option selected UI
    markSelectedOptionUI(i);

    // update progress
    updatePaletteVisuals();
};

// helper: toggle .selected on option labels for a question
function markSelectedOptionUI(i) {
    const qArea = document.getElementById('q-area');
    if(!qArea) return;
    const inputs = qArea.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    inputs.forEach(inp => {
        const parent = inp.closest('.option');
        if(!parent) return;
        if(inp.checked) parent.classList.add('selected');
        else parent.classList.remove('selected');
    });
}

// TIMER & SUBMIT
function formatTime(sec) {
    if (sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return [h, m, s].map(n => String(n).padStart(2,'0')).join(':');
}

function startTimer(sec) {
    let rem = sec;
    document.getElementById('timer').innerText = formatTime(rem);
    timerInterval = setInterval(() => {
        rem--;
        document.getElementById('timer').innerText = formatTime(rem);
        if(rem<=0) {
            clearInterval(timerInterval);
            submitExam(false);
        }
    }, 1000);
}

document.getElementById('submit-btn').onclick = () => {
    if(confirm("Submit Exam?")) submitExam(false);
};

async function submitExam(disqualified) {
    clearInterval(timerInterval);
    document.exitFullscreen().catch(()=>{});

    // 1. Calculate Score
    let score = 0;
    currentExam.questions.forEach((q, i) => {
        if(q.type=='MCQ' && userAnswers[i] == q.correct) score += 4;
        else if(q.type=='INTEGER' && userAnswers[i] == q.correct) score += 4;
        else if(userAnswers[i] !== undefined) score -= 1;
    });
    if(disqualified) score = -10;

    // 2. Save Result (include answers for detailed analysis)
    const resultDoc = await addDoc(collection(db, "results"), {
        uid: currentUser.uid,
        email: currentUser.email,
        name: currentUser.displayName || '',
        testId: currentExam.id,
        score: score,
        answers: userAnswers,
        status: disqualified ? "DISQUALIFIED" : "COMPLETED",
        timestamp: new Date().toISOString()
    });

    // 3. Update Live Status to Completed
    if (liveStatusDocId) {
        await updateDoc(doc(db, "live_status", liveStatusDocId), {
            status: disqualified ? "Disqualified" : "Completed"
        });
    }

    // Show results/analysis view for this exam
    await loadExamAnalysis(currentExam.id);
    document.getElementById('exam-view').classList.add('hidden');
    document.getElementById('result-view').classList.remove('hidden');
}

// VIEW ANALYSIS FROM DASHBOARD
window.viewAnalysis = async (testId) => {
    const docSnap = await getDoc(doc(db, "tests", testId));
    if(!docSnap.exists()) {
        alert('Exam not found');
        return;
    }
    await loadExamAnalysis(testId);
    document.getElementById('auth-view').classList.add('hidden');
    document.getElementById('dashboard-view').classList.add('hidden');
    document.getElementById('exam-view').classList.add('hidden');
    document.getElementById('result-view').classList.remove('hidden');
};

// LOAD EXAM ANALYSIS & LIVE RANK
async function loadExamAnalysis(testId) {
    const testSnap = await getDoc(doc(db, "tests", testId));
    if(!testSnap.exists()) {
        document.getElementById('detailed-solutions').innerText = 'No exam data available.';
        return;
    }
    const examData = testSnap.data();

    // fetch all results for this test
    const q = query(collection(db, "results"), where("testId", "==", testId));
    const snap = await getDocs(q);
    const results = [];
    snap.forEach(s => results.push({ id: s.id, ...s.data() }));

    // Normalize answers keys to numeric indices (Firestore stores object keys as strings)
    results.forEach(r => {
        if (r.answers && typeof r.answers === 'object') {
            const norm = {};
            Object.keys(r.answers).forEach(k => {
                // convert numeric-like keys to numbers
                const idx = Number(k);
                norm[idx] = r.answers[k];
            });
            r.answers = norm;
        } else {
            r.answers = {};
        }
    });

    // sort by score desc, timestamp asc
    results.sort((a, b) => {
        if ((b.score||0) !== (a.score||0)) return (b.score||0) - (a.score||0);
        return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
    });

    // compute top performers list (top 5)
    const top = results.slice(0, 5);

    // find current user's result and rank (match by uid or email)
    const uid = currentUser?.uid;
    const myIndex = uid ? results.findIndex(r => r.uid === uid || r.email === currentUser.email) : -1;
    const myResult = myIndex >= 0 ? results[myIndex] : null;
    const myRank = myIndex >= 0 ? (myIndex + 1) : 'Not attempted';

    // aggregate per-question stats (requires results to include answers)
    const qCount = Array.isArray(examData.questions) ? examData.questions.length : 0;
    const perQ = Array.from({length: qCount}, () => ({ attempts:0, correct:0, optionCount: {} }));

    results.forEach(r => {
        const ans = r.answers || {};
        for (let i = 0; i < qCount; i++) {
            if (Object.prototype.hasOwnProperty.call(ans, i) && ans[i] !== undefined && ans[i] !== null && ans[i] !== '') {
                perQ[i].attempts++;
                const given = ans[i];
                perQ[i].optionCount[given] = (perQ[i].optionCount[given] || 0) + 1;
                const correct = examData.questions[i].correct;
                if (String(given) === String(correct)) perQ[i].correct++;
            }
        }
    });

    // overall stats
    const totalAttempts = results.length;
    const avgScore = totalAttempts ? Math.round(results.reduce((s,r)=>s+(r.score||0),0)/totalAttempts) : 0;

    // populate result-summary
    document.getElementById('res-score').innerText = myResult ? myResult.score : 'N/A';
    document.getElementById('res-rank').innerText = myRank;
    document.getElementById('res-acc').innerText = myResult ? `${calculateAccuracy(myResult.answers, examData.questions)}%` : `${totalAttempts ? Math.round((perQ.reduce((s,p)=>s+p.correct,0) / (totalAttempts * qCount))*100) : 0}%`;

    // build detailed HTML
    const container = document.getElementById('detailed-solutions');
    container.innerHTML = `<h3 style="margin-top:0">${escapeHtml(examData.title || 'Exam')} — Detailed Analysis</h3>
        <div style="display:flex; gap:16px; margin-bottom:12px; align-items:center;">
            <div><strong>Total Attempts:</strong> ${totalAttempts}</div>
            <div><strong>Average Score:</strong> ${avgScore}</div>
        </div>
        <div style="margin-bottom:18px;">
            <h4>Top Performers</h4>
            <ol id="top-list">${top.map(t => `<li>${escapeHtml(t.name||t.email||'Unknown')} — ${t.score}</li>`).join('')}</ol>
        </div>
        <div>
            <h4>Per Question Stats</h4>
            <div id="per-q-list">${ Array.isArray(examData.questions) ? examData.questions.map((qq, idx) => {
                const stats = perQ[idx] || { attempts:0, correct:0, optionCount:{} };
                const pctCorrect = stats.attempts ? Math.round((stats.correct / stats.attempts)*100) : 0;
                const optionDist = (qq.options && qq.options.length) ? Object.keys(stats.optionCount).map(k => {
                    const count = stats.optionCount[k] || 0;
                    // if options indexed numerically, show letter; otherwise show as-is
                    const label = (isFinite(k) && qq.options[Number(k)] !== undefined) ? String.fromCharCode(65+Number(k)) : String(k);
                    return `<div style="font-size:0.95rem; color:var(--muted)">${escapeHtml(String(label))}: ${count}</div>`;
                }).join('') : '';
                return `<div class="card" style="margin-bottom:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div><strong>Q${idx+1}:</strong> ${escapeHtml(qq.text)}</div>
                        <div style="color:var(--muted)">${pctCorrect}% correct</div>
                    </div>
                    <div style="margin-top:8px">${optionDist}</div>
                    <div style="margin-top:8px; font-size:0.95rem; color:var(--muted)">Correct Answer: ${formatCorrect(qq)}</div>
                </div>`;
            }).join('') : '' }</div>
        </div>`;

    // helper functions
    function calculateAccuracy(ansObj = {}, questions = []) {
        if (!questions || !Array.isArray(questions)) return 0;
        let correct = 0, attempted = 0;
        for (let i = 0; i < questions.length; i++) {
            if (Object.prototype.hasOwnProperty.call(ansObj, i) && ansObj[i] !== undefined && ansObj[i] !== null && ansObj[i] !== '') {
                attempted++;
                if (String(ansObj[i]) === String(questions[i].correct)) correct++;
            }
        }
        return attempted ? Math.round((correct/attempted)*100) : 0;
    }
    function formatCorrect(q) {
        if (!q) return '';
        if (q.type === 'MCQ') return (isFinite(q.correct) ? String.fromCharCode(65 + Number(q.correct)) : String(q.correct));
        return String(q.correct);
    }
    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    }
}