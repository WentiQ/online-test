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
    'introduction-view': document.getElementById('introduction-view'),
    'main-instructions-view': document.getElementById('main-instructions-view'),
    'result-view': document.getElementById('result-view'),
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
                footerHTML = `<button class="btn btn-primary" style="width:100%" onclick="window.startExam('${d.id}')">Start Exam</button>`;
            } else {
                // Attempted at least once
                const isLimitReached = attemptCount >= maxAttempts;
                
                // Button 1: Analysis or Result based on exam type
                let viewBtn = '';
                if (t.resultType === 'result') {
                    // Result type - show Result button
                    viewBtn = `<button class="btn btn-success" style="flex:1" onclick="window.loadResult('${latestResult.id}')">View Result</button>`;
                } else {
                    // Analysis type (default)
                    viewBtn = `<button class="btn btn-success" style="flex:1" onclick="window.loadAnalysis('${latestResult.id}')">Analysis</button>`;
                }
                
                // Button 2: Retake (If limit not reached)
                let retakeBtn = '';
                if (!isLimitReached) {
                    retakeBtn = `<button class="btn btn-outline" style="flex:1" onclick="window.startExam('${d.id}')">Retake</button>`;
                } else {
                    retakeBtn = `<button class="btn btn-outline" style="flex:1" disabled title="Max attempts reached">Limit Reached</button>`;
                }

                statusBadge = `<span style="color:var(--success); font-weight:bold; font-size:0.8rem">● Attempt ${attemptCount}/${maxAttempts}</span>`;
                footerHTML = `<div style="display:flex; gap:10px; width:100%">${viewBtn}${retakeBtn}</div>`;
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
            // Get the exam data to check result type
            const examData = [...testsSnap.docs].find(d => d.id === r.testId);
            const isResultType = examData && examData.data().resultType === 'result';
            
            if (isResultType) {
                // For result-type exams, show qualification status instead of score
                let statusIcon = '⏳';
                let statusText = 'Result Pending';
                let statusColor = '#ffc107';
                
                if (r.resultReleased) {
                    if (r.qualified === true) {
                        statusIcon = '✅';
                        statusText = 'Qualified';
                        statusColor = '#28a745';
                    } else if (r.qualified === false) {
                        statusIcon = '❌';
                        statusText = 'Not Qualified';
                        statusColor = '#dc3545';
                    }
                }
                
                hist.innerHTML += `
                    <div class="dash-card" style="border-left:4px solid ${statusColor}; cursor:pointer" onclick="window.loadResult('${r.id}')">
                        <h4>${r.examTitle || 'Exam'}</h4>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px">
                            <span style="color:${statusColor}; font-weight:bold;">${statusIcon} ${statusText}</span>
                            <small>${new Date(r.timestamp).toLocaleDateString()}</small>
                        </div>
                    </div>`;
            } else {
                // For analysis-type exams, show score as before
                hist.innerHTML += `
                    <div class="dash-card" style="border-left:4px solid var(--primary); cursor:pointer" onclick="window.loadAnalysis('${r.id}')">
                        <h4>${r.examTitle || 'Exam'}</h4>
                        <div style="display:flex; justify-content:space-between; margin-top:10px">
                            <span>Score: <b>${r.score}</b></span>
                            <small>${new Date(r.timestamp).toLocaleDateString()}</small>
                        </div>
                    </div>`;
            }
        });

    } catch (e) { console.error(e); }
}

// --- Student Details State ---
let studentFullName = '';
let studentPhone = '';
let studentEmail = '';
let studentBranch = '';
let pendingExamId = null;

// --- Student Details Modal Functions ---
window.startExam = function(examId) {
    pendingExamId = examId;
    const modal = document.getElementById('student-details-modal');
    
    // Pre-fill with previously entered details if available
    document.getElementById('student-full-name').value = studentFullName || currentUser.displayName || '';
    document.getElementById('student-phone').value = studentPhone || '';
    document.getElementById('student-email').value = studentEmail || currentUser.email || '';
    document.getElementById('student-branch').value = studentBranch || '';
    
    modal.classList.remove('hidden');
    document.getElementById('student-full-name').focus();
};

window.cancelStudentDetails = function() {
    document.getElementById('student-details-modal').classList.add('hidden');
    pendingExamId = null;
};

// Show/hide other branch field
document.getElementById('student-branch').addEventListener('change', function() {
    const otherContainer = document.getElementById('other-branch-container');
    const otherInput = document.getElementById('student-branch-other');
    if (this.value === 'other') {
        otherContainer.style.display = 'block';
        otherInput.required = true;
    } else {
        otherContainer.style.display = 'none';
        otherInput.required = false;
        otherInput.value = '';
    }
});

document.getElementById('student-details-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    console.log('Form submitted');
    
    // Get all field values
    studentFullName = document.getElementById('student-full-name').value.trim();
    studentPhone = document.getElementById('student-phone').value.trim();
    studentEmail = document.getElementById('student-email').value.trim();
    const branchSelect = document.getElementById('student-branch').value;
    const branchOther = document.getElementById('student-branch-other').value.trim();
    
    // Validate required fields
    if (!studentFullName || !studentPhone || !studentEmail || !branchSelect) {
        alert('Please fill in all required fields.');
        return;
    }
    
    // Validate phone number
    if (studentPhone.length !== 10 || !/^\d+$/.test(studentPhone)) {
        alert('Please enter a valid 10-digit WhatsApp number.');
        return;
    }
    
    // Validate email
    if (!studentEmail.includes('@')) {
        alert('Please enter a valid email address.');
        return;
    }
    
    // Handle branch selection
    if (branchSelect === 'other') {
        if (!branchOther) {
            alert('Please specify your branch name.');
            return;
        }
        studentBranch = branchOther;
    } else {
        studentBranch = branchSelect;
    }
    
    console.log('Student details validated:', {studentFullName, studentPhone, studentEmail, studentBranch});
    console.log('Pending exam ID:', pendingExamId);
    
    // Hide modal first
    document.getElementById('student-details-modal').classList.add('hidden');
    console.log('Modal hidden');
    
    // Show introduction immediately
    console.log('Calling showIntroduction...');
    showIntroduction(pendingExamId);
});

// Introduction timer state
let introTimerInterval = null;
let introTimeRemaining = 0;

// Main instructions timer state
let mainInstructionsTimerInterval = null;
let mainInstructionsTimeRemaining = 0;

// Show introduction page
async function showIntroduction(examId) {
    try {
        console.log('Loading introduction for exam:', examId);
        const docSnap = await getDoc(doc(db, "tests", examId));
        if(!docSnap.exists()) { 
            alert("Exam not found"); 
            return; 
        }
        
        const exam = docSnap.data();
        const introduction = exam.introduction;
        
        console.log('Introduction data type:', typeof introduction);
        console.log('Introduction data:', introduction);
        
        let introTitle = exam.title || 'Exam Instructions';
        let introContent = 'No specific instructions provided.<br><br>Good luck with your exam!';
        let introBanner = '';
        
        if (introduction && typeof introduction === 'object' && !Array.isArray(introduction)) {
            // JSON format (object)
            console.log('Using JSON format for introduction');
            introTitle = introduction.title || introTitle;
            introContent = introduction.content || introContent;
            if (introduction.banner) {
                introBanner = `<img src="${introduction.banner}" style="max-width: 100%; height: auto; margin-bottom: 20px; border-radius: 8px;">`;
                console.log('Banner added:', introduction.banner);
            }
        } else if (introduction && typeof introduction === 'string') {
            // Legacy text format
            console.log('Using legacy text format for introduction');
            introContent = introduction;
        } else {
            console.log('No introduction data or invalid format');
        }
        
        console.log('Setting introduction content...');
        document.getElementById('intro-title').innerText = introTitle;
        document.getElementById('intro-content').innerHTML = introBanner + introContent;
        
        // Start introduction timer
        introTimeRemaining = exam.introTimeLimit || 120; // Default 2 minutes
        console.log('Starting timer with', introTimeRemaining, 'seconds');
        startIntroductionTimer();
        
        console.log('Switching to introduction-view...');
        switchView('introduction-view');
        console.log('Introduction view should now be visible');
    } catch(e) {
        console.error('Error in showIntroduction:', e);
        alert('Error loading exam details: ' + e.message);
    }
}

function startIntroductionTimer() {
    if (introTimerInterval) clearInterval(introTimerInterval);
    
    updateIntroTimerDisplay();
    
    introTimerInterval = setInterval(() => {
        introTimeRemaining--;
        updateIntroTimerDisplay();
        
        if (introTimeRemaining <= 0) {
            clearInterval(introTimerInterval);
            // Auto-proceed to main instructions when intro time runs out
            proceedToMainInstructions();
        }
    }, 1000);
}

function updateIntroTimerDisplay() {
    const minutes = Math.floor(introTimeRemaining / 60);
    const seconds = introTimeRemaining % 60;
    document.getElementById('intro-timer').innerText = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    // Change color when time is running low
    if (introTimeRemaining <= 30) {
        document.getElementById('intro-timer').style.color = 'var(--danger)';
    } else {
        document.getElementById('intro-timer').style.color = 'var(--primary)';
    }
}

window.cancelIntroduction = function() {
    if (introTimerInterval) clearInterval(introTimerInterval);
    if (mainInstructionsTimerInterval) clearInterval(mainInstructionsTimerInterval);
    pendingExamId = null;
    switchView('dash');
};

// Proceed from introduction to main instructions
window.proceedToMainInstructions = function() {
    console.log('Proceeding to main instructions');
    if (introTimerInterval) {
        clearInterval(introTimerInterval);
        console.log('Introduction timer cleared');
    }
    
    // Show main instructions view
    switchView('main-instructions-view');
    
    // Start main instructions timer (default 5 minutes = 300 seconds)
    mainInstructionsTimeRemaining = 300;
    startMainInstructionsTimer();
};

function startMainInstructionsTimer() {
    if (mainInstructionsTimerInterval) clearInterval(mainInstructionsTimerInterval);
    
    updateMainInstructionsTimerDisplay();
    
    mainInstructionsTimerInterval = setInterval(() => {
        mainInstructionsTimeRemaining--;
        updateMainInstructionsTimerDisplay();
        
        if (mainInstructionsTimeRemaining <= 0) {
            clearInterval(mainInstructionsTimerInterval);
            // Auto-start exam when main instructions time runs out
            confirmAndStartExam();
        }
    }, 1000);
}

function updateMainInstructionsTimerDisplay() {
    const minutes = Math.floor(mainInstructionsTimeRemaining / 60);
    const seconds = mainInstructionsTimeRemaining % 60;
    document.getElementById('main-instructions-timer').innerText = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    // Change color when time is running low
    if (mainInstructionsTimeRemaining <= 60) {
        document.getElementById('main-instructions-timer').style.color = 'var(--danger)';
    } else {
        document.getElementById('main-instructions-timer').style.color = 'var(--primary)';
    }
}

window.cancelMainInstructions = function() {
    if (mainInstructionsTimerInterval) clearInterval(mainInstructionsTimerInterval);
    if (introTimerInterval) clearInterval(introTimerInterval);
    pendingExamId = null;
    switchView('dash');
};

window.confirmAndStartExam = function() {
    console.log('Confirm and start exam clicked');
    if (introTimerInterval) {
        clearInterval(introTimerInterval);
        console.log('Introduction timer cleared');
    }
    if (mainInstructionsTimerInterval) {
        clearInterval(mainInstructionsTimerInterval);
        console.log('Main instructions timer cleared');
    }
    if (pendingExamId) {
        console.log('Starting exam:', pendingExamId);
        window.initExam(pendingExamId);
    } else {
        console.error('No pending exam ID!');
    }
};

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

        // 3. Store display options for use throughout exam
        // If result type, hide marking scheme completely
        if (currentExam.resultType === 'result') {
            window.currentExamDisplayOptions = {
                showMarkingScheme: false,
                showRank: false,
                showFinalMarks: false,
                showCorrectAnswers: false
            };
        } else {
            window.currentExamDisplayOptions = currentExam.displayOptions || {
                showMarkingScheme: true,
                showRank: true,
                showFinalMarks: true,
                showCorrectAnswers: true
            };
        }
        
        // 3. Flatten questions for navigation
        if (currentExam.sections && Array.isArray(currentExam.sections)) {
            flattenQuestions(currentExam.sections, true);
        } else {
            flattenQuestions(currentExam.questions, false);
        }

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
                uid: currentUser.uid, 
                name: studentFullName || currentUser.displayName, 
                phone: studentPhone || '',
                testId: tid, 
                status: "Active", 
                lastActive: new Date().toISOString()
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

    // Check if we're entering a new section
    const prevQ = idx > 0 ? flatQuestions[idx - 1] : null;
    const isNewSection = !prevQ || (q.sectionIdx !== undefined && q.sectionIdx !== prevQ.sectionIdx);
    
    if (isNewSection && q.sectionTitle) {
        // Show section instruction modal/alert
        if (prevQ && prevQ.sectionIdx !== q.sectionIdx) {
            alert(`📘 ${q.sectionTitle}\n\n${q.sectionInstruction || 'No specific instructions for this section.'}`);
        }
    }

    // Initialize tempAnswer with saved answer for this question
    tempAnswer = userAnswers[idx] !== undefined ? JSON.parse(JSON.stringify(userAnswers[idx])) : null;

    let imgHTML = q.img ? `<img src="${q.img}" class="q-img" onerror="this.style.display='none'">` : '';
    
    // Check if marking scheme should be shown
    let marks = '';
    if (window.currentExamDisplayOptions && window.currentExamDisplayOptions.showMarkingScheme) {
        marks = `(+${q.pos || q.marks || 4}, -${q.neg || q.negativeMarks || 1})`;
    }

    let questionText = q.question || q.text || '';
    let inputHTML = '';
    
    // Show section instruction below the question
    let sectionInfoHTML = '';
    if (q.sectionTitle) {
        sectionInfoHTML = `
            <div style="background: #e8f0fe; border-left: 4px solid var(--primary); padding: 12px; margin-bottom: 15px; border-radius: 4px;">
                <strong style="color: var(--primary);">${q.sectionTitle}</strong>
                ${q.sectionInstruction ? `<div style="margin-top: 5px; font-size: 0.9rem; color: var(--gray);">${q.sectionInstruction}</div>` : ''}
            </div>
        `;
    }

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

    // Build meta info without marks if disabled
    let metaHTML = `<span>Q${idx+1} (${q.type})</span>`;
    if (marks) {
        metaHTML += `<span>Marks: ${marks}</span>`;
    }
    
    area.innerHTML = `
        <div class="question-card">
            ${sectionInfoHTML}
            <div class="q-meta">${metaHTML}</div>
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
    
    let lastSectionIdx = -1;
    
    for (let i = 0; i < flatQuestions.length; i++) {
        const q = flatQuestions[i];
        
        // Add section header if entering new section
        if (q.sectionIdx !== undefined && q.sectionIdx !== lastSectionIdx) {
            const sectionHeader = document.createElement('div');
            sectionHeader.style.cssText = 'grid-column: 1 / -1; font-weight: bold; font-size: 0.8rem; color: var(--primary); margin-top: 10px; padding: 5px; background: #e8f0fe; border-radius: 4px; text-align: center;';
            sectionHeader.innerText = q.sectionTitle || `Section ${q.sectionIdx + 1}`;
            grid.appendChild(sectionHeader);
            lastSectionIdx = q.sectionIdx;
        }
        
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

// Store exam data temporarily for feedback submission
let tempExamData = null;

window.submitExam = async () => {
    if(!confirm("Submit Exam?")) return;
    document.getElementById('submit-btn').innerText = "Processing...";
    clearInterval(timerInterval);
    try { document.exitFullscreen().catch(()=>{}); } catch(e){}

    let score = 0;
    let details = [];

    // Use flatQuestions which works for both sectioned and flat formats
    flatQuestions.forEach((q, i) => {
        let uAns = userAnswers[i];
        // For multi correct, ensure empty array is saved as null
        if (q.type === 'multi' && (!uAns || uAns.length === 0)) uAns = null;
        // For passage, ensure empty object is saved as null
        if (q.type === 'passage' && (!uAns || Object.keys(uAns).length === 0)) uAns = null;
        // For other types, if undefined, set to null
        if (uAns === undefined) uAns = null;

        let marks = 0;
        let isCorrect = false;

        // Scoring logic with relative grading support
        if (uAns !== null) {
            // Check if question has relative grading
            if (q.relativeGrading && typeof q.relativeGrading === 'object') {
                // Relative grading: marks based on option selected
                const userAnsKey = String(uAns);
                marks = parseFloat(q.relativeGrading[userAnsKey] || 0);
                // For relative grading, consider it correct if marks > 0
                isCorrect = marks > 0;
            } else if (q.type === 'multi' && Array.isArray(uAns) && Array.isArray(q.answer)) {
                // Multi-correct with JEE Advanced style partial marking
                const allCorrect = uAns.every(v => q.answer.includes(v));
                const allAnswersSelected = uAns.length === q.answer.length && allCorrect;
                
                if (allAnswersSelected) {
                    marks = parseFloat(q.marks || 4);
                    isCorrect = true;
                } else if (allCorrect && uAns.length > 0) {
                    const correctCount = uAns.length;
                    const totalCorrect = q.answer.length;
                    marks = parseFloat(q.marks || 4) * (correctCount / totalCorrect);
                    isCorrect = false;
                } else {
                    marks = -parseFloat(q.negativeMarks || 0);
                    isCorrect = false;
                }
            } else if (q.type === 'passage' && Array.isArray(q.questions)) {
                marks = 0;
            } else if (uAns == (q.answer ?? q.correct)) {
                marks = parseFloat(q.marks || 4);
                isCorrect = true;
            } else {
                marks = -parseFloat(q.negativeMarks || 0);
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

    // Store exam data for feedback submission
    tempExamData = {
        uid: currentUser.uid,
        studentName: studentFullName || currentUser.displayName || 'Student',
        studentPhone: studentPhone || '',
        studentEmail: studentEmail || currentUser.email || '',
        studentBranch: studentBranch || '',
        email: currentUser.email || '',
        examTitle: currentExam.title,
        testId: currentExam.id,
        score,
        details,
        totalTimeSpent: Object.values(timeLog).reduce((a, b) => a + b, 0),
        timestamp: new Date().toISOString()
    };

    // Hide exam view and show feedback modal
    document.getElementById('exam-view').classList.add('hidden');
    document.getElementById('feedback-modal').classList.remove('hidden');
    document.getElementById('submit-btn').innerText = "Submit";
};
document.getElementById('submit-btn').onclick = window.submitExam;

// --- FEEDBACK FUNCTIONALITY ---
let selectedRating = 0;

// Star rating interaction
const stars = document.querySelectorAll('.star');
stars.forEach(star => {
    star.addEventListener('click', function() {
        selectedRating = parseInt(this.dataset.rating);
        document.getElementById('feedback-rating').value = selectedRating;
        document.getElementById('rating-error').style.display = 'none';
        updateStars(selectedRating);
    });
    
    star.addEventListener('mouseenter', function() {
        const hoverRating = parseInt(this.dataset.rating);
        updateStars(hoverRating, true);
    });
    
    star.addEventListener('mouseleave', function() {
        updateStars(selectedRating);
    });
});

function updateStars(rating, isHover = false) {
    stars.forEach((star, index) => {
        const starRating = index + 1;
        star.classList.remove('selected', 'hovered');
        if (starRating <= rating) {
            star.classList.add(isHover ? 'hovered' : 'selected');
            star.textContent = '★';
        } else {
            star.textContent = '☆';
        }
    });
}

// Feedback form submission
document.getElementById('feedback-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    const rating = parseInt(document.getElementById('feedback-rating').value);
    const difficulty = document.getElementById('feedback-difficulty').value;
    const comments = document.getElementById('feedback-comments').value.trim();
    
    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
        document.getElementById('rating-error').style.display = 'block';
        return;
    }
    
    // Validate difficulty
    if (!difficulty) {
        alert('Please select the question difficulty level.');
        return;
    }
    
    // Disable submit button
    const submitBtn = this.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    
    try {
        // Add feedback data to exam result
        tempExamData.feedback = {
            rating,
            difficulty,
            comments,
            submittedAt: new Date().toISOString()
        };
        
        // Save to Firestore
        const resultDoc = await addDoc(collection(db, "results"), tempExamData);
        
        if (liveDocId) updateDoc(doc(db, "live_status", liveDocId), { status: "Completed" });
        
        // Store result ID for PDF generation
        window.lastSubmittedResultId = resultDoc.id;
        
        // Hide feedback modal
        document.getElementById('feedback-modal').classList.add('hidden');
        
        // Reset form
        document.getElementById('feedback-form').reset();
        selectedRating = 0;
        updateStars(0);
        
        // Show popup to download PDF
        const downloadNow = confirm("✅ Exam submitted successfully!\n\nYour responses have been recorded.\n\nWould you like to download your exam response PDF now?");
        
        if (downloadNow) {
            await downloadSubmittedExamPDF();
        }
        
        // Redirect to result/analysis based on exam type
        if (currentExam.resultType === 'result') {
            window.loadResult(resultDoc.id);
        } else {
            window.loadAnalysis(resultDoc.id);
        }
        
    } catch(e) {
        console.error(e);
        alert("Error submitting feedback: " + e.message);
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Feedback & View Results';
    }
});

// --- ANALYSIS FUNCTIONS ---
window.loadAnalysis = async (resultId) => {
    try {
        const resSnap = await getDoc(doc(db, "results", resultId));
        currentAnalysisData = resSnap.data();
        
        const testSnap = await getDoc(doc(db, "tests", currentAnalysisData.testId));
        currentTestSchema = testSnap.data();

        // Check if any question is missing answer key
        const hasMissingAnswers = currentTestSchema.questions.some(q => {
            if (q.type === 'passage' && Array.isArray(q.questions)) {
                return q.questions.some(subQ => !subQ.answer && subQ.answer !== 0 && !subQ.correct && subQ.correct !== 0);
            }
            return !q.answer && q.answer !== 0 && !q.correct && q.correct !== 0;
        });

        // Check if results are released or if answers are missing
        if (currentTestSchema.resultsReleased === false || hasMissingAnswers) {
            switchView('anOverview');
            document.getElementById('an-score').innerText = '---';
            document.getElementById('an-rank').innerText = '---';
            document.getElementById('an-accuracy').innerText = '---';
            document.getElementById('an-grid').innerHTML = `
                <div style="grid-column: 1 / -1; text-align:center; padding:40px; background:white; border-radius:8px;">
                    <div style="font-size:3rem; margin-bottom:10px;">⏳</div>
                    <h3 style="color:var(--primary); margin-bottom:10px;">Results Under Evaluation</h3>
                    <p style="color:var(--gray);">Your exam has been submitted successfully. Results will be released soon by the admin.</p>
                    <p style="color:var(--gray); font-size:0.9rem; margin-top:15px;">You will be able to view your score, rank, and detailed solutions once the results are announced.</p>
                </div>
            `;
            return;
        }

        // FIX: Flatten analysis questions here!
        if (currentTestSchema.sections && Array.isArray(currentTestSchema.sections)) {
            flattenAnalysisQuestions(currentTestSchema.sections, true);
        } else {
            flattenAnalysisQuestions(currentTestSchema.questions, false);
        }

        switchView('anOverview');
        
        // Get display options and store globally (default all to true for backward compatibility)
        window.currentAnalysisDisplayOptions = currentTestSchema.displayOptions || {
            showMarkingScheme: true,
            showRank: true,
            showFinalMarks: true,
            showCorrectAnswers: true
        };
        const displayOptions = window.currentAnalysisDisplayOptions;
        console.log('Display options loaded:', displayOptions);
        
        // Handle Score Display
        const scoreContainer = document.getElementById('score-container');
        if (!scoreContainer) {
            console.error('❌ score-container NOT FOUND in DOM!');
        } else {
            console.log('✓ score-container found');
            if (displayOptions.showFinalMarks) {
                scoreContainer.style.display = '';
                const scoreLabel = scoreContainer.querySelector('p');
                if (scoreLabel) scoreLabel.innerText = 'Your Score';
                document.getElementById('an-score').innerText = `${currentAnalysisData.score} / ${currentTestSchema.questions.length * 4}`;
                document.getElementById('an-score').style.color = '';
                console.log('Score shown:', currentAnalysisData.score);
            } else {
                // Show qualified/not qualified instead of marks
                scoreContainer.style.display = '';
                const scoreLabel = scoreContainer.querySelector('p');
                if (scoreLabel) scoreLabel.innerText = 'Result';
                const totalMarks = currentTestSchema.questions.length * 4;
                const passingPercentage = 40; // 40% passing criteria
                const passingMarks = (totalMarks * passingPercentage) / 100;
                const isQualified = currentAnalysisData.score >= passingMarks;
                document.getElementById('an-score').innerText = isQualified ? '✅ QUALIFIED' : '❌ NOT QUALIFIED';
                document.getElementById('an-score').style.color = isQualified ? 'var(--success)' : 'var(--danger)';
                console.log('Showing qualification status instead of marks');
            }
        }
        
        // Handle Rank Display
        const rankContainer = document.getElementById('rank-container');
        if (!rankContainer) {
            console.error('❌ rank-container NOT FOUND in DOM!');
        } else {
            console.log('✓ rank-container found');
            if (!displayOptions.showRank) {
                rankContainer.style.display = 'none';
                console.log('✓✓✓ Rank container HIDDEN with display=none');
            } else {
                rankContainer.style.display = '';
                console.log('Rank container visible');
            }
        }
        
        // Handle Accuracy Display
        const accuracyContainer = document.getElementById('accuracy-container');
        if (!accuracyContainer) {
            console.error('❌ accuracy-container NOT FOUND in DOM!');
        } else {
            console.log('✓ accuracy-container found');
            if (!displayOptions.showFinalMarks) {
                accuracyContainer.style.display = 'none';
                console.log('✓✓✓ Accuracy container HIDDEN with display=none');
            } else {
                accuracyContainer.style.display = '';
                console.log('Accuracy container visible');
            }
        }

        // --- Exact Rank Calculation ---
        if (displayOptions.showRank) {
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
        } else {
            document.getElementById('an-rank').innerText = '---';
        }

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
    
    // Use globally stored display options
    const displayOptions = window.currentAnalysisDisplayOptions || {
        showMarkingScheme: true,
        showRank: true,
        showFinalMarks: true,
        showCorrectAnswers: true
    };

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
            
            // Only highlight correct answer if admin allows
            if (displayOptions.showCorrectAnswers && i == (q.answer ?? q.correct)) { 
                borderStyle = '2px solid var(--success)'; 
                bgStyle = '#e6fffa'; 
            }
            
            // Show wrong answers (always show user's mistakes)
            if (detail.userAns == i && !detail.isCorrect) { 
                borderStyle = '2px solid var(--danger)'; 
                bgStyle = '#fff5f5'; 
            }
            
            optionsHTML += `
                <div class="option-box" style="border:${borderStyle}; background:${bgStyle}; cursor:default">
                    <div>${txt}</div>
                    ${(displayOptions.showCorrectAnswers && i == (q.answer ?? q.correct)) ? '<i class="fa fa-check" style="color:green; margin-left:auto"></i>' : ''}
                    ${(detail.userAns == i && !detail.isCorrect) ? '<i class="fa fa-times" style="color:red; margin-left:auto"></i>' : ''}
                </div>`;
        });
        optionsHTML += `</div>`;
        userAnsHTML = (detail.userAns !== null) ? `<div><b>Your Answer:</b> ${getOptTxt(q.options[detail.userAns])}</div>` : '';
        correctAnsHTML = displayOptions.showCorrectAnswers ? `<div><b>Correct Answer:</b> ${getOptTxt(q.options[q.answer ?? q.correct])}</div>` : '';
    } else if (q.type === 'multi') {
        optionsHTML = `<div class="options-grid">`;
        q.options.forEach((opt, i) => {
            let txt = getOptTxt(opt);
            let isCorrect = Array.isArray(q.answer) && q.answer.includes(i);
            let isUser = Array.isArray(detail.userAns) && detail.userAns.includes(i);
            let borderStyle = '2px solid #ddd', bgStyle = '#fff';
            
            // Only show correct answers if admin allows
            if (displayOptions.showCorrectAnswers && isCorrect) { 
                borderStyle = '2px solid var(--success)'; 
                bgStyle = '#e6fffa'; 
            }
            
            // Always show user's wrong selections
            if (isUser && !isCorrect) { 
                borderStyle = '2px solid var(--danger)'; 
                bgStyle = '#fff5f5'; 
            }
            
            optionsHTML += `
                <div class="option-box" style="border:${borderStyle}; background:${bgStyle}; cursor:default">
                    <div>${txt}</div>
                    ${(displayOptions.showCorrectAnswers && isCorrect) ? '<i class="fa fa-check" style="color:green; margin-left:auto"></i>' : ''}
                    ${(isUser && !isCorrect) ? '<i class="fa fa-times" style="color:red; margin-left:auto"></i>' : ''}
                </div>`;
        });
        optionsHTML += `</div>`;
        userAnsHTML = (Array.isArray(detail.userAns)) ? `<div><b>Your Answer:</b> ${detail.userAns.map(i => getOptTxt(q.options[i])).join(', ')}</div>` : '';
        correctAnsHTML = displayOptions.showCorrectAnswers && Array.isArray(q.answer) ? `<div><b>Correct Answer:</b> ${q.answer.map(i => getOptTxt(q.options[i])).join(', ')}</div>` : '';
    } else if (q.type === 'integer' || q.type === 'numerical') {
        userAnsHTML = (detail.userAns !== null) ? `<div><b>Your Answer:</b> ${detail.userAns}</div>` : '';
        correctAnsHTML = displayOptions.showCorrectAnswers ? `<div><b>Correct Answer:</b> ${q.answer ?? q.correct}</div>` : '';
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
                
                if (displayOptions.showCorrectAnswers) {
                    if (isCorrect && isUser) cell = '<span style="color:green">&#10004;</span>'; // correct tick
                    else if (isCorrect) cell = '<span style="color:green">&#10003;</span>'; // correct only
                    else if (isUser) cell = '<span style="color:red">&#10008;</span>'; // user wrong
                } else {
                    // Only show user's wrong answers
                    if (isUser && !isCorrect) cell = '<span style="color:red">&#10008;</span>';
                }
                
                optionsHTML += `<td style="text-align:center">${cell}</td>`;
            });
            optionsHTML += `</tr>`;
        });
        optionsHTML += `</table>`;
        // Show user and correct answers as text
        userAnsHTML = `<div><b>Your Matches:</b> ${JSON.stringify(user)}</div>`;
        correctAnsHTML = displayOptions.showCorrectAnswers ? `<div><b>Correct Matches:</b> ${JSON.stringify(correct)}</div>` : '';
    }

    // Build marks display
    let marksHTML = '';
    if (displayOptions.showMarkingScheme) {
        marksHTML = `<span style="font-weight:bold; color:${detail.marks >= 0 ? 'var(--success)' : 'var(--danger)'}">Marks: ${detail.marks > 0 ? '+' : ''}${detail.marks}</span>`;
    }
    
    // Hide correct answers if admin disabled
    const correctAnswerHTML = displayOptions.showCorrectAnswers ? correctAnsHTML : '';
    const explanationHTML = displayOptions.showCorrectAnswers && q.explanation ? `<div class="explanation-box"><strong>Explanation:</strong><br>${q.explanation}</div>` : '';
    
    // Build meta info conditionally
    let metaItems = [`<span>Q${idx+1}</span>`, `<span>Time Spent: ${Math.round(detail.time)}s</span>`];
    if (marksHTML) {
        metaItems.push(marksHTML);
    }
    
    document.getElementById('sol-content').innerHTML = `
        <div class="sol-status ${statusClass}">${statusText}</div>
        <div class="q-meta">${metaItems.join('')}</div>
        ${q.img ? `<img src="${q.img}" class="q-img">` : ''}
        ${passageHTML}
        <div class="q-text">${questionText}</div>
        ${optionsHTML}
        ${userAnsHTML}
        ${correctAnswerHTML}
        ${explanationHTML}
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
function flattenQuestions(questionsOrSections, isSectionBased = false) {
    flatQuestions = [];
    flatToOriginal = [];
    
    if (isSectionBased) {
        // Handle section-based structure
        questionsOrSections.forEach((section, sectionIdx) => {
            if (!Array.isArray(section.questions)) return;
            
            section.questions.forEach((q, qIdx) => {
                if (q.type === 'passage' && Array.isArray(q.questions)) {
                    q.questions.forEach((subq, subIdx) => {
                        flatQuestions.push({
                            ...subq,
                            passage: q.passage,
                            sectionTitle: section.title,
                            sectionInstruction: section.instruction,
                            sectionIdx: sectionIdx,
                            parentIdx: qIdx,
                            subIdx: subIdx,
                            type: subq.type || 'single'
                        });
                        flatToOriginal.push({ section: sectionIdx, parent: qIdx, sub: subIdx });
                    });
                } else {
                    flatQuestions.push({
                        ...q,
                        sectionTitle: section.title,
                        sectionInstruction: section.instruction,
                        sectionIdx: sectionIdx
                    });
                    flatToOriginal.push({ section: sectionIdx, parent: qIdx, sub: null });
                }
            });
        });
    } else {
        // Legacy format: flat array of questions
        questionsOrSections.forEach((q, i) => {
            if (q.type === 'passage' && Array.isArray(q.questions)) {
                q.questions.forEach((subq, subIdx) => {
                    flatQuestions.push({
                        ...subq,
                        passage: q.passage,
                        parentIdx: i,
                        subIdx: subIdx,
                        type: subq.type || 'single'
                    });
                    flatToOriginal.push({ parent: i, sub: subIdx });
                });
            } else {
                flatQuestions.push(q);
                flatToOriginal.push({ parent: i, sub: null });
            }
        });
    }
}

// Flatten analysis questions for easier navigation in analysis view
function flattenAnalysisQuestions(questionsOrSections, isSectionBased = false) {
    analysisFlatQuestions = [];
    analysisFlatToOriginal = [];
    
    if (isSectionBased) {
        // Handle section-based structure
        questionsOrSections.forEach((section, sectionIdx) => {
            if (!Array.isArray(section.questions)) return;
            
            section.questions.forEach((q, qIdx) => {
                if (q.type === 'passage' && Array.isArray(q.questions)) {
                    q.questions.forEach((subq, subIdx) => {
                        analysisFlatQuestions.push({
                            ...subq,
                            passage: q.passage,
                            sectionTitle: section.title,
                            sectionInstruction: section.instruction,
                            sectionIdx: sectionIdx,
                            parentIdx: qIdx,
                            subIdx: subIdx,
                            type: subq.type || 'single'
                        });
                        analysisFlatToOriginal.push({ section: sectionIdx, parent: qIdx, sub: subIdx });
                    });
                } else {
                    analysisFlatQuestions.push({
                        ...q,
                        sectionTitle: section.title,
                        sectionInstruction: section.instruction,
                        sectionIdx: sectionIdx
                    });
                    analysisFlatToOriginal.push({ section: sectionIdx, parent: qIdx, sub: null });
                }
            });
        });
    } else {
        // Legacy format: flat array of questions
        questionsOrSections.forEach((q, i) => {
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

// --- PDF DOWNLOAD FUNCTION ---
window.downloadExamPDF = async function() {
    if (!currentTestSchema || !currentAnalysisData) {
        alert('No exam data available for download.');
        return;
    }
    
    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        let yPos = 20;
        const pageHeight = doc.internal.pageSize.height;
        const margin = 20;
        const lineHeight = 7;
        
        // Helper function to add text with page break
        const addText = (text, x, fontSize = 12, isBold = false) => {
            if (yPos > pageHeight - 30) {
                doc.addPage();
                yPos = 20;
            }
            doc.setFontSize(fontSize);
            doc.setFont(undefined, isBold ? 'bold' : 'normal');
            doc.text(text, x, yPos);
            yPos += lineHeight;
        };
        
        const addMultilineText = (text, x, maxWidth, fontSize = 11) => {
            doc.setFontSize(fontSize);
            const lines = doc.splitTextToSize(text, maxWidth);
            lines.forEach(line => {
                if (yPos > pageHeight - 30) {
                    doc.addPage();
                    yPos = 20;
                }
                doc.text(line, x, yPos);
                yPos += lineHeight;
            });
        };
        
        // Title
        addText(currentTestSchema.title || 'Exam Report', margin, 18, true);
        yPos += 5;
        
        // Student Info
        addText(`Student: ${studentFullName || currentUser.displayName || 'Student'}`, margin, 12);
        if (studentPhone) addText(`Phone: ${studentPhone}`, margin, 12);
        addText(`Date: ${new Date(currentAnalysisData.timestamp).toLocaleString()}`, margin, 12);
        yPos += 5;
        
        // Introduction
        if (currentTestSchema.introduction) {
            addText('INTRODUCTION', margin, 14, true);
            addMultilineText(currentTestSchema.introduction, margin, 170, 10);
            yPos += 5;
        }
        
        // Section divider
        doc.setDrawColor(0, 0, 0);
        doc.line(margin, yPos, 190, yPos);
        yPos += 10;
        
        // Questions and Answers
        addText('YOUR RESPONSES', margin, 14, true);
        yPos += 3;
        
        let lastSectionIdx = -1;
        
        analysisFlatQuestions.forEach((q, idx) => {
            const detail = currentAnalysisData.details[idx];
            
            // Add section header if entering new section
            if (q.sectionIdx !== undefined && q.sectionIdx !== lastSectionIdx) {
                yPos += 3;
                addText(q.sectionTitle || `Section ${q.sectionIdx + 1}`, margin, 13, true);
                if (q.sectionInstruction) {
                    addMultilineText(q.sectionInstruction, margin + 5, 165, 10);
                }
                yPos += 3;
                lastSectionIdx = q.sectionIdx;
            }
            
            // Question number and status
            let status = 'Skipped';
            if (detail.userAns !== null) {
                status = detail.isCorrect ? 'Correct' : 'Wrong';
            }
            addText(`Q${idx + 1}. ${status}`, margin, 12, true);
            
            // Question text (remove HTML tags for PDF)
            const questionText = (q.question || q.text || '').replace(/<[^>]*>/g, '');
            addMultilineText(questionText, margin + 5, 165, 11);
            
            // User's answer
            let userAnsText = 'Not Answered';
            if (detail.userAns !== null) {
                if (q.type === 'single' && q.options) {
                    userAnsText = `Your Answer: ${q.options[detail.userAns]}`.replace(/<[^>]*>/g, '');
                } else if (q.type === 'multi' && Array.isArray(detail.userAns) && q.options) {
                    userAnsText = `Your Answer: ${detail.userAns.map(i => q.options[i]).join(', ')}`.replace(/<[^>]*>/g, '');
                } else if (q.type === 'integer' || q.type === 'numerical') {
                    userAnsText = `Your Answer: ${detail.userAns}`;
                } else {
                    userAnsText = `Your Answer: ${JSON.stringify(detail.userAns)}`;
                }
            }
            addMultilineText(userAnsText, margin + 5, 165, 10);
            yPos += 5;
        });
        
        // Save PDF
        const filename = `${currentTestSchema.title || 'Exam'}_${studentFullName || 'Student'}_${new Date().toISOString().split('T')[0]}.pdf`;
        doc.save(filename);
        
    } catch (error) {
        console.error('PDF Generation Error:', error);
        alert('Error generating PDF. Please try again.');
    }
};

// --- RESULT VIEW (for result-type exams) ---
window.loadResult = async (resultId) => {
    try {
        const resSnap = await getDoc(doc(db, "results", resultId));
        if (!resSnap.exists()) {
            alert('Result not found');
            return;
        }
        
        const resultData = resSnap.data();
        
        const testSnap = await getDoc(doc(db, "tests", resultData.testId));
        const testData = testSnap.data();
        
        switchView('result-view');
        
        // Check if result is released
        if (resultData.resultReleased !== true) {
            document.getElementById('result-status').innerText = '⏳';
            document.getElementById('result-title').innerText = 'Result Under Review';
            document.getElementById('result-message').innerText = 'Your exam has been submitted successfully. The admin is reviewing all responses. Results will be announced soon.';
            document.getElementById('result-details').innerHTML = `
                <p style="margin:0;"><strong>Exam:</strong> ${testData.title}</p>
                <p style="margin:10px 0 0 0;"><strong>Submitted on:</strong> ${new Date(resultData.timestamp).toLocaleString()}</p>
                <div style="margin-top:20px; text-align:center;">
                    <button class="btn btn-primary" onclick="downloadSubmittedExamPDF('${resultId}')">
                        <i class="fa fa-download"></i> Download Exam Response PDF
                    </button>
                </div>
            `;
            return;
        }
        
        // Result is released - show qualification status
        const isQualified = resultData.qualified === true;
        
        if (isQualified) {
            document.getElementById('result-status').innerText = '🎉';
            document.getElementById('result-title').innerText = 'Congratulations!';
            document.getElementById('result-title').style.color = 'var(--success)';
            document.getElementById('result-message').innerText = 'You have been declared QUALIFIED for this examination.';
        } else {
            document.getElementById('result-status').innerText = '📋';
            document.getElementById('result-title').innerText = 'Result Declared';
            document.getElementById('result-title').style.color = 'var(--danger)';
            document.getElementById('result-message').innerText = 'Unfortunately, you have not qualified in this examination.';
        }
        
        document.getElementById('result-details').innerHTML = `
            <p style="margin:0;"><strong>Exam:</strong> ${testData.title}</p>
            <p style="margin:10px 0 0 0;"><strong>Submitted on:</strong> ${new Date(resultData.timestamp).toLocaleString()}</p>
            <p style="margin:10px 0 0 0;"><strong>Result announced on:</strong> ${new Date(resultData.releasedAt).toLocaleString()}</p>
            <div style="margin-top:20px; padding:15px; background:${isQualified ? '#d4edda' : '#f8d7da'}; border-radius:6px; text-align:center;">
                <h3 style="margin:0; color:${isQualified ? 'green' : 'red'};">${isQualified ? '✅ QUALIFIED' : '❌ NOT QUALIFIED'}</h3>
            </div>
            <div style="margin-top:20px; text-align:center;">
                <button class="btn btn-primary" onclick="downloadSubmittedExamPDF('${resultId}')">
                    <i class="fa fa-download"></i> Download Exam Response PDF
                </button>
            </div>
        `;
        
    } catch(e) {
        console.error(e);
        alert('Error loading result: ' + e.message);
    }
};

// --- DOWNLOAD SUBMITTED EXAM PDF (Student's Responses Only) ---
window.downloadSubmittedExamPDF = async function(resultId) {
    try {
        const useResultId = resultId || window.lastSubmittedResultId;
        if (!useResultId) {
            alert('Unable to generate PDF. Please try again.');
            return;
        }
        
        // Fetch result data
        const resultDocRef = doc(db, "results", useResultId);
        const resultSnap = await getDoc(resultDocRef);
        if (!resultSnap.exists()) {
            alert('Result not found');
            return;
        }
        
        const resultData = resultSnap.data();
        
        // Fetch exam data
        const examDocRef = doc(db, "tests", resultData.testId);
        const examSnap = await getDoc(examDocRef);
        if (!examSnap.exists()) {
            alert('Exam not found');
            return;
        }
        
        const examData = examSnap.data();
        
        // Flatten questions
        let questions = [];
        if (examData.sections && Array.isArray(examData.sections)) {
            examData.sections.forEach(section => {
                if (Array.isArray(section.questions)) {
                    questions.push(...section.questions);
                }
            });
        } else if (Array.isArray(examData.questions)) {
            questions = examData.questions;
        }
        
        // Generate PDF using jsPDF
        const { jsPDF } = window.jspdf;
        const pdfDoc = new jsPDF();
        
        let yPos = 20;
        const margin = 15;
        const pageHeight = pdfDoc.internal.pageSize.height;
        const pageWidth = pdfDoc.internal.pageSize.width;
        const maxWidth = pageWidth - (2 * margin);
        
        // Helper function to convert image URL to base64
        async function loadImageAsBase64(imagePath) {
            return new Promise((resolve, reject) => {
                if (!imagePath) {
                    resolve(null);
                    return;
                }
                
                const img = new Image();
                img.crossOrigin = 'Anonymous';
                
                img.onload = function() {
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        const dataURL = canvas.toDataURL('image/jpeg', 0.8);
                        resolve(dataURL);
                    } catch (err) {
                        console.warn('Error converting image:', err);
                        resolve(null);
                    }
                };
                
                img.onerror = function() {
                    console.warn('Failed to load image:', imagePath);
                    resolve(null);
                };
                
                // Handle relative paths from images folder
                if (!imagePath.startsWith('http') && !imagePath.startsWith('data:')) {
                    img.src = imagePath.startsWith('images/') ? imagePath : `images/${imagePath}`;
                } else {
                    img.src = imagePath;
                }
            });
        }
        
        // Helper function to add text with word wrap
        function addText(text, x, y, fontSize = 10, isBold = false) {
            pdfDoc.setFontSize(fontSize);
            pdfDoc.setFont(undefined, isBold ? 'bold' : 'normal');
            return pdfDoc.text(text, x, y, { maxWidth: maxWidth });
        }
        
        // Helper function to add multiline text and return height
        function addMultilineText(text, x, y, fontSize = 10, maxW = null) {
            pdfDoc.setFontSize(fontSize);
            pdfDoc.setFont(undefined, 'normal');
            const lines = pdfDoc.splitTextToSize(text, maxW || maxWidth);
            pdfDoc.text(lines, x, y);
            return lines.length * (fontSize * 0.4);
        }
        
        // Helper to check if we need a new page
        function checkPageBreak(requiredSpace = 40) {
            if (yPos + requiredSpace > pageHeight - 20) {
                pdfDoc.addPage();
                yPos = 20;
                return true;
            }
            return false;
        }
        
        // Title
        pdfDoc.setFillColor(66, 133, 244);
        pdfDoc.rect(0, 0, pageWidth, 30, 'F');
        pdfDoc.setTextColor(255, 255, 255);
        pdfDoc.setFontSize(18);
        pdfDoc.setFont(undefined, 'bold');
        pdfDoc.text('EXAM RESPONSE SHEET', pageWidth / 2, 18, { align: 'center' });
        pdfDoc.setTextColor(0, 0, 0);
        
        yPos = 40;
        
        // Student Details (Introduction section removed from PDF)
        pdfDoc.setFontSize(14);
        pdfDoc.setFont(undefined, 'bold');
        pdfDoc.text('Student Information', margin, yPos);
        yPos += 8;
        
        pdfDoc.setFontSize(10);
        pdfDoc.setFont(undefined, 'normal');
        pdfDoc.text(`Name: ${resultData.studentName || 'N/A'}`, margin, yPos);
        yPos += 6;
        pdfDoc.text(`WhatsApp: ${resultData.studentPhone || 'N/A'}`, margin, yPos);
        yPos += 6;
        pdfDoc.text(`Email: ${resultData.studentEmail || resultData.email || 'N/A'}`, margin, yPos);
        yPos += 6;
        pdfDoc.text(`Branch: ${resultData.studentBranch || 'N/A'}`, margin, yPos);
        yPos += 10;
        
        // Exam Details
        pdfDoc.setFontSize(14);
        pdfDoc.setFont(undefined, 'bold');
        pdfDoc.text('Exam Information', margin, yPos);
        yPos += 8;
        
        pdfDoc.setFontSize(10);
        pdfDoc.setFont(undefined, 'normal');
        pdfDoc.text(`Exam: ${examData.title || 'N/A'}`, margin, yPos);
        yPos += 6;
        pdfDoc.text(`Submitted: ${new Date(resultData.timestamp).toLocaleString()}`, margin, yPos);
        yPos += 6;
        pdfDoc.text(`Time Taken: ${Math.floor(resultData.totalTimeSpent / 60)} minutes ${Math.floor(resultData.totalTimeSpent % 60)} seconds`, margin, yPos);
        yPos += 15;
        
        // Questions and Answers
        pdfDoc.setFontSize(14);
        pdfDoc.setFont(undefined, 'bold');
        pdfDoc.text('Your Responses', margin, yPos);
        yPos += 10;
        
        for (let idx = 0; idx < questions.length; idx++) {
            const q = questions[idx];
            checkPageBreak(60);
            
            const detail = resultData.details[idx] || {};
            const userAns = detail.userAns;
            
            // Determine status
            let status = 'Not Visited';
            let statusColor = [150, 150, 150];
            if (userAns === null || userAns === undefined) {
                status = 'Skipped';
                statusColor = [255, 193, 7];
            } else {
                status = 'Answered';
                statusColor = [76, 175, 80];
            }
            
            // Question header
            pdfDoc.setFillColor(240, 240, 240);
            pdfDoc.rect(margin, yPos, maxWidth, 8, 'F');
            pdfDoc.setFontSize(11);
            pdfDoc.setFont(undefined, 'bold');
            pdfDoc.text(`Question ${idx + 1}`, margin + 2, yPos + 5);
            
            // Status badge
            pdfDoc.setFillColor(...statusColor);
            pdfDoc.rect(pageWidth - margin - 30, yPos, 30, 8, 'F');
            pdfDoc.setTextColor(255, 255, 255);
            pdfDoc.setFontSize(8);
            pdfDoc.text(status, pageWidth - margin - 28, yPos + 5);
            pdfDoc.setTextColor(0, 0, 0);
            
            yPos += 12;
            
            // Question text
            pdfDoc.setFontSize(10);
            pdfDoc.setFont(undefined, 'normal');
            const qText = q.question || q.text || 'No question text';
            const qHeight = addMultilineText(qText, margin + 2, yPos, 10);
            yPos += qHeight + 5;
            
            // Question image
            if (q.image) {
                checkPageBreak(60);
                try {
                    const imgData = await loadImageAsBase64(q.image);
                    if (imgData) {
                        const imgWidth = 80;
                        const imgHeight = 60;
                        pdfDoc.addImage(imgData, 'JPEG', margin + 2, yPos, imgWidth, imgHeight);
                        yPos += imgHeight + 5;
                    }
                } catch (err) {
                    console.warn('Could not add question image:', err);
                }
            }
            
            checkPageBreak(30);
            
            // Options (for MCQ)
            if (q.type === 'single' || q.type === 'multi') {
                if (q.options && Array.isArray(q.options)) {
                    for (let optIdx = 0; optIdx < q.options.length; optIdx++) {
                        const opt = q.options[optIdx];
                        checkPageBreak(40);
                        const optText = typeof opt === 'object' ? opt.text : opt;
                        const optImage = typeof opt === 'object' ? opt.image : null;
                        const isSelected = Array.isArray(userAns) ? userAns.includes(optIdx) : userAns === optIdx;
                        
                        // Option label and text with proper wrapping
                        const optLabel = String.fromCharCode(65 + optIdx);
                        const optionTextWidth = maxWidth - 8; // Leave space for indentation
                        
                        pdfDoc.setFontSize(10);
                        pdfDoc.setFont(undefined, isSelected ? 'bold' : 'normal');
                        
                        // Split option text into lines
                        const optLines = pdfDoc.splitTextToSize(`${optLabel}) ${optText}`, optionTextWidth);
                        const optTextHeight = optLines.length * 5;
                        
                        // Check if we need more space for multiline option
                        if (optTextHeight > 6) {
                            checkPageBreak(optTextHeight + 10);
                        }
                        
                        // Highlight selected option
                        if (isSelected) {
                            pdfDoc.setFillColor(173, 216, 230);
                            pdfDoc.rect(margin + 2, yPos - 4, maxWidth - 4, optTextHeight + 2, 'F');
                        }
                        
                        pdfDoc.text(optLines, margin + 4, yPos);
                        yPos += optTextHeight + 2;
                        
                        // Option image
                        if (optImage) {
                            checkPageBreak(45);
                            try {
                                const imgData = await loadImageAsBase64(optImage);
                                if (imgData) {
                                    const imgWidth = 60;
                                    const imgHeight = 45;
                                    pdfDoc.addImage(imgData, 'JPEG', margin + 10, yPos, imgWidth, imgHeight);
                                    yPos += imgHeight + 3;
                                }
                            } catch (err) {
                                console.warn('Could not add option image:', err);
                            }
                        }
                    }
                }
            } else {
                // For numerical/integer type
                const ansText = userAns !== null && userAns !== undefined ? `Your Answer: ${userAns}` : 'Not Answered';
                pdfDoc.setFont(undefined, 'bold');
                pdfDoc.text(ansText, margin + 4, yPos);
                yPos += 6;
            }
            
            yPos += 8;
        }
        
        // Footer on last page
        pdfDoc.setFontSize(8);
        pdfDoc.setTextColor(150, 150, 150);
        pdfDoc.text('This is a computer-generated document. No signature required.', pageWidth / 2, pageHeight - 10, { align: 'center' });
        
        // Save PDF
        const filename = `${examData.title || 'Exam'}_Response_${resultData.studentName || 'Student'}_${new Date().toISOString().split('T')[0]}.pdf`;
        pdfDoc.save(filename);
        
        console.log('PDF downloaded successfully');
        
    } catch (error) {
        console.error('PDF Generation Error:', error);
        alert('Error generating PDF. Please try again.');
    }
};