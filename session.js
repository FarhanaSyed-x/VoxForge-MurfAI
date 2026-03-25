/* ═══════════════════════════════════════════════════════════════
   VOXFORGE — SESSION BACKEND
   Pure JS — no HTML, no CSS
   Connect to session.html via:
     <script src="session.js"></script>
     <script>VoxForgeSession.init();</script>
   ═══════════════════════════════════════════════════════════════ */

const GEMINI_API_KEY = window.VOXFORGE_KEYS?.GEMINI_API_KEY || '';
const MURF_API_KEY   = window.VOXFORGE_KEYS?.MURF_API_KEY || '';

/* ── API endpoints ── */
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent';
const MURF_TTS_URL = 'https://api.murf.ai/v1/speech/generate';

/* ═══════════════════════════════════════════════════════════════
   MAIN MODULE
   ═══════════════════════════════════════════════════════════════ */
const VoxForgeSession = (() => {

  /* ── Session state ── */
  let config         = null;   // vf_config from sessionStorage
  let questions      = [];     // 10 generated questions
  let answers        = [];     // { question, transcript, scores, timeLeft }
  let currentQ       = 0;      // 0-indexed
  let timerInterval  = null;
  let timeLeft       = 0;
  let recognition    = null;   // Web Speech API instance
  let currentTranscript = '';  // live transcript for current question
  let audioQueue     = [];     // pre-fetched audio: {blob, text}
  let sessionLocked  = false;  // prevent double-triggers

  /* ── Callbacks the HTML hooks into ── */
  const on = {
    status:       () => {},   // (message) — loading/status text
    questionStart: () => {},  // (questionObj, index, total) — new question started
    transcript:   () => {},   // (text) — live mic transcript update
    timerTick:    () => {},   // (secondsLeft) — every second
    timerEnd:     () => {},   // () — timer hit zero
    answerLocked: () => {},   // (answerObj, index) — answer saved
    scoreReady:   () => {},   // (answerObj, index) — Gemini score returned
    report:       () => {},   // (resultsObj) — all done, render report
    error:        () => {},   // (message) — something went wrong
  };

  /* ═══════════════════
     INIT
     ═══════════════════ */
  async function init(callbacks = {}) {
    Object.assign(on, callbacks);

    /* 1. Load config */
    try {
      config = JSON.parse(sessionStorage.getItem('vf_config'));
      if (!config) throw new Error('No session config found. Please start from the beginning.');
    } catch (e) {
      on.error(e.message);
      return;
    }

    on.status('Generating your 10 questions...');

    /* 2. Generate questions via Gemini */
    try {
      questions = await generateQuestions();
    } catch (e) {
      on.error('Failed to generate questions: ' + e.message);
      return;
    }

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      on.error('Failed to generate questions: Invalid response from Gemini');
      return;
    }

    on.status('Preparing voice audio...');

    /* 3. Pre-fetch Murf audio for all questions */
    try {
      audioQueue = await prefetchAudio(questions);
    } catch (e) {
      // Non-fatal — fall back to no audio
      console.warn('Murf audio prefetch failed, continuing without audio:', e.message);
      audioQueue = questions.map(q => ({blob: null, text: q.text}));
    }

    on.status('Session ready. Starting now...');

    /* 4. Begin first question */
    await startQuestion(0);
  }

  /* ═══════════════════
     GEMINI — QUESTION GENERATION
     ═══════════════════ */
  async function generateQuestions() {
    const { prompt, personaName, role, level, timer } = config;

    const systemPrompt = buildQuestionSystemPrompt(role, personaName, level, timer);
    const userPrompt = `The user's situation: "${prompt}"\n\nGenerate exactly 10 questions. Return ONLY a valid JSON array of 10 strings. No markdown, no explanation, no numbering — just the raw JSON array.`;

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.85, maxOutputTokens: 1024 }
          })
        });

        if (res.status === 429) {
          // Rate limit exceeded, wait with exponential backoff
          const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
          console.warn(`Rate limit hit, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        if (!res.ok) throw new Error(`Gemini API error ${res.status}`);
        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleaned = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Invalid question format from Gemini');
        return parsed.slice(0, 10).map((q, i) => ({ id: i + 1, text: q }));
      } catch (e) {
        if (attempt === maxRetries - 1) {
          console.warn('All Gemini API attempts failed, using mock questions for demo');
          // Fallback to mock questions
          return [
            { id: 1, text: "Can you describe your current situation in more detail?" },
            { id: 2, text: "What challenges are you facing right now?" },
            { id: 3, text: "How do you think this situation could be improved?" },
            { id: 4, text: "What resources or support do you have available?" },
            { id: 5, text: "What is your ultimate goal in this scenario?" },
            { id: 6, text: "How have you handled similar situations before?" },
            { id: 7, text: "What constraints or limitations are you working with?" },
            { id: 8, text: "Who else is involved and what are their perspectives?" },
            { id: 9, text: "What would success look like for you?" },
            { id: 10, text: "What questions do you have about this situation?" }
          ];
        }
        console.warn(`Attempt ${attempt + 1} failed: ${e.message}, retrying...`);
      }
    }
  }

  function buildQuestionSystemPrompt(role, personaName, level, timer) {
    const pressureMap = {
      beginner:     'relaxed, encouraging tone — give the user space to think',
      intermediate: 'professional, moderately challenging — push for specifics',
      expert:       'high pressure, aggressive follow-ups — probe hard, challenge every claim'
    };
    const pressure = pressureMap[level] || pressureMap.intermediate;

    const personaMap = {
      interview: 'a tough hiring manager conducting a job interview. Ask behavioural, situational, and skills-based questions. Use STAR-method-style prompts.',
      investor:  'a sceptical VC investor hearing a startup pitch. Challenge the business model, financials, competition, and founder credibility.',
      client:    'an angry enterprise client who is frustrated about a missed deadline or poor service. Demand accountability and solutions.',
      customer:  'a cautious potential buyer evaluating a product or service. Ask probing questions about value, ROI, and differentiators.',
      salary:    'a manager being asked for a salary raise. Push back on the ask, question the timing, demand justification with data.',
      audience:  'a live conference audience member. Ask challenging, insightful questions that test the speaker\'s depth of knowledge.',
      manager:   'a direct manager doing a performance review. Probe deliverables, growth areas, and future plans with pointed questions.',
      casual:    'a new acquaintance at a networking event. Ask engaging, natural conversation-starter questions to build rapport.',
    };
    const persona = personaMap[role] || personaMap.interview;

    return `You are ${persona}
Your name/title is: ${personaName}
Difficulty level: ${level} (${pressure})
Each question must be answerable within approximately ${timer} seconds when spoken aloud.
Questions must be directly relevant to the user's specific situation.
Vary the question types — do not ask the same thing twice.
Be concise — each question should be 1-2 sentences maximum.
Do not include preamble, pleasantries, or numbering in the questions themselves.`;
  }

  /* ═══════════════════
     MURF — AUDIO PREFETCH
     ═══════════════════ */
  function fetchWithTimeout(url, options = {}, timeout = 15000) {
    return Promise.race([
      fetch(url, options),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), timeout))
    ]);
  }

  async function prefetchAudio(questions) {
    const { voiceId, langCode } = config;
    const audioItems = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      try {
        on.status(`Preparing voice audio... (${i + 1}/${questions.length})`);
        const blob = await fetchMurfAudio(q.text, voiceId, langCode);
        audioItems.push({blob, text: q.text});
      } catch (err) {
        console.warn('Murf audio prefetch error:', err.message);
        audioItems.push({blob: null, text: q.text});
      }

      // mild delay
      await new Promise(resolve => setTimeout(resolve, 350));
    }

    return audioItems;
  }

  async function fetchMurfAudio(text, voiceId, langCode) {
    const res = await fetchWithTimeout(MURF_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': MURF_API_KEY,
      },
      body: JSON.stringify({
        voiceId: voiceId,
        style: 'Conversational',
        text: text,
        rate: 0,
        pitch: 0,
        sampleRate: 24000,
        format: 'MP3',
        channelType: 'MONO',
        pronunciationDictionary: {},
        encodeAsBase64: false,
        variation: 1,
        audioDuration: 0,
        modelVersion: 'GEN2'
      })
    });
    if (!res.ok) throw new Error(`Murf error ${res.status}`);
    const data = await res.json();
    /* Murf returns audioFile URL — fetch and cache as blob */
    if (data.audioFile) {
      const audioRes = await fetch(data.audioFile);
      return await audioRes.blob();
    }
    throw new Error('No audioFile in Murf response');
  }

  function playAudioBlob(audioItem) {
    if (!audioItem) return Promise.resolve();
    if (audioItem.blob) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(audioItem.blob);
        const audio = new Audio(url);
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => { resolve(); };
        audio.play().catch(() => resolve());
      });
    } else {
      // Use Web Speech API
      return new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(audioItem.text);
        
        // Set language
        utterance.lang = config.langCode || 'en-US';
        
        // Set voice based on language and selected voice name
        const voices = speechSynthesis.getVoices();
        let selectedVoice = null;
        
        // First try to find voice matching selected name
        if (config.voiceName) {
          selectedVoice = voices.find(v => v.name.toLowerCase().includes(config.voiceName.toLowerCase()));
        }
        
        // Then try to find voice matching language
        if (!selectedVoice) {
          selectedVoice = voices.find(v => v.lang === utterance.lang);
        }
        
        // If not found, try partial match
        if (!selectedVoice) {
          selectedVoice = voices.find(v => v.lang.startsWith(utterance.lang.split('-')[0]));
        }
        
        // If still not found, use default
        if (!selectedVoice && voices.length > 0) {
          selectedVoice = voices[0];
        }
        
        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }
        
        utterance.onend = resolve;
        utterance.onerror = resolve;
        speechSynthesis.speak(utterance);
      });
    }
  }

  /* ═══════════════════
     QUESTION FLOW
     ═══════════════════ */
  async function startQuestion(index) {
    if (index >= questions.length) {
      await finishSession();
      return;
    }

    currentQ = index;
    currentTranscript = '';
    sessionLocked = false;
    timeLeft = config.timer;

    const q = questions[index];
    on.questionStart(q, index, questions.length);
    on.timerTick(timeLeft);

    /* Play Murf audio first, then start timer + mic */
    await playAudioBlob(audioQueue[index]);

    startMic();
    startTimer();
  }

  /* ═══════════════════
     TIMER
     ═══════════════════ */
  function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      timeLeft--;
      on.timerTick(timeLeft);
      if (timeLeft <= 0) {
        clearInterval(timerInterval);
        on.timerEnd();
        lockAnswer();
      }
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
  }

  /* ═══════════════════
     MIC — Web Speech API
     ═══════════════════ */
  function startMic() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      on.error('Speech recognition not supported in this browser. Please use Chrome.');
      return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = config.langCode || 'en-US';

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t + ' ';
        else interim += t;
      }
      currentTranscript += final;
      on.transcript((currentTranscript + interim).trim());
    };

    recognition.onerror = (e) => {
      if (e.error !== 'no-speech') console.warn('Speech recognition error:', e.error);
    };

    recognition.onend = () => {
      /* Auto-restart if session still active and timer still running */
      if (!sessionLocked && timeLeft > 0) {
        try { recognition.start(); } catch (_) {}
      }
    };

    try { recognition.start(); } catch (_) {}
  }

  function stopMic() {
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
      recognition = null;
    }
  }

  /* ═══════════════════
     LOCK ANSWER
     ═══════════════════ */
  function lockAnswer() {
    if (sessionLocked) return;
    sessionLocked = true;

    stopTimer();
    stopMic();

    const answerObj = {
      questionId: currentQ + 1,
      question: questions[currentQ].text,
      transcript: currentTranscript.trim() || '[No answer recorded]',
      timeUsed: config.timer - timeLeft,
      timeLeft: timeLeft,
      scores: null,
    };

    answers.push(answerObj);
    const answerIndex = answers.length - 1;
    on.answerLocked(answerObj, answerIndex);

    /* Score in background — don't block next question */
    scoreAnswer(answerObj, answerIndex);

    /* Move to next question after short pause */
    setTimeout(() => startQuestion(currentQ + 1), 1800);
  }

  /* ═══════════════════
     GEMINI — SCORING
     ═══════════════════ */
  async function scoreAnswer(answerObj, index) {
    if (answerObj.transcript === '[No answer recorded]') {
      answerObj.scores = { clarity: 0, thoughtfulness: 0, honesty: 0, adaptability: 0, overall: 0, feedback: 'No answer was recorded for this question.' };
      on.scoreReady(answerObj, index);
      return;
    }

    const prompt = buildScoringPrompt(answerObj.question, answerObj.transcript, config.role, config.level);

    try {
      const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 512 }
        })
      });

      if (!res.ok) throw new Error(`Gemini scoring error ${res.status}`);
      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const scores = JSON.parse(cleaned);

      answerObj.scores = {
        clarity:        clamp(scores.clarity, 0, 10),
        thoughtfulness: clamp(scores.thoughtfulness, 0, 10),
        honesty:        clamp(scores.honesty, 0, 10),
        adaptability:   clamp(scores.adaptability, 0, 10),
        overall:        clamp(scores.overall, 0, 10),
        feedback:       scores.feedback || '',
      };
    } catch (e) {
      console.warn('Scoring failed for Q' + answerObj.questionId, e.message);
      answerObj.scores = { clarity: 0, thoughtfulness: 0, honesty: 0, adaptability: 0, overall: 0, feedback: 'Scoring unavailable.' };
    }

    on.scoreReady(answerObj, index);
  }

  function buildScoringPrompt(question, answer, role, level) {
    return `You are an expert communication coach evaluating a spoken answer in a ${role} scenario at ${level} difficulty.

Question asked: "${question}"
User's answer: "${answer}"

Score the answer on these 4 traits, each from 0 to 10:
- clarity: How clear, structured, and easy to understand was the answer?
- thoughtfulness: How considered, nuanced, and well-reasoned was the answer?
- honesty: How authentic, direct, and genuine did the answer feel? (penalise vague or evasive answers)
- adaptability: How well did the answer address the specific question and context?
- overall: A holistic score from 0 to 10.
- feedback: One sentence of specific, actionable coaching feedback.

Return ONLY a valid JSON object. No markdown, no explanation. Example format:
{"clarity":7,"thoughtfulness":6,"honesty":8,"adaptability":7,"overall":7,"feedback":"Your answer was clear but lacked a specific example to back up your claim."}`;
  }

  /* ═══════════════════
     FINISH SESSION & BUILD REPORT
     ═══════════════════ */
  async function finishSession() {
    /* Wait for all scoring to complete (max 8s) */
    on.status('Calculating your results...');
    await waitForScores(8000);

    const results = buildResults();
    on.report(results);
  }

  function waitForScores(maxMs) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = setInterval(() => {
        const allScored = answers.every(a => a.scores !== null);
        if (allScored || Date.now() - start > maxMs) {
          clearInterval(check);
          resolve();
        }
      }, 300);
    });
  }

  function buildResults() {
    const scored = answers.filter(a => a.scores);
    const avg = (key) => scored.length ? round(scored.reduce((s, a) => s + (a.scores[key] || 0), 0) / scored.length, 1) : 0;

    const traitAverages = {
      clarity:        avg('clarity'),
      thoughtfulness: avg('thoughtfulness'),
      honesty:        avg('honesty'),
      adaptability:   avg('adaptability'),
      overall:        avg('overall'),
    };

    const totalTime = answers.reduce((s, a) => s + a.timeUsed, 0);
    const answeredCount = answers.filter(a => a.transcript !== '[No answer recorded]').length;

    /* Determine strongest and weakest trait */
    const traitKeys = ['clarity','thoughtfulness','honesty','adaptability'];
    const sorted = [...traitKeys].sort((a, b) => traitAverages[b] - traitAverages[a]);
    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];

    return {
      config,
      answers,
      traitAverages,
      totalQuestions: questions.length,
      answeredCount,
      totalTime,
      strongest,
      weakest,
      completedAt: new Date().toISOString(),
    };
  }

  /* ═══════════════════
     UTILITIES
     ═══════════════════ */
  function clamp(val, min, max) { return Math.min(max, Math.max(min, Number(val) || 0)); }
  function round(val, dp) { return Math.round(val * 10 ** dp) / 10 ** dp; }

  /* ── Public API ── */
  return { init };

})();
