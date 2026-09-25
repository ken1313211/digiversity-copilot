const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('app.js', 'utf8').replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\.\/firebase-config\.js";/, '');
const html = fs.readFileSync('index.html', 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function harness(room = null) {
    const dom = new JSDOM(html, { url: 'http://localhost/demo/', runScripts: 'outside-only' });
    const w = dom.window;
    const originalAdd = w.document.addEventListener.bind(w.document);
    w.document.addEventListener = (name, callback, ...rest) => {
        if (name === 'DOMContentLoaded') return;
        originalAdd(name, callback, ...rest);
    };
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    const data = { sessions: { '123456': clone(room) }, '.info': { connected: true, serverTimeOffset: 0 } };
    const listeners = new Set();
    const timers = new Map();
    const disconnects = new Map();
    let timerId = 0, pushId = 0, transactions = 0;
    let failTransaction = false;
    const read = path => path.split('/').reduce((value, key) => value?.[key], data) ?? null;
    const snapshot = path => ({ exists: () => read(path) !== null, val: () => clone(read(path)) });
    const write = (path, value) => {
        const parts = path.split('/');
        let target = data;
        for (const part of parts.slice(0, -1)) target = target[part] ||= {};
        if (value === null) delete target[parts.at(-1)];
        else target[parts.at(-1)] = clone(value);
    };
    const notify = listener => {
        const value = JSON.stringify(read(listener.path));
        if (listener.last === value) return;
        listener.last = value;
        listener.callback(snapshot(listener.path));
    };
    const emit = () => { for (const listener of [...listeners]) notify(listener); };
    Object.assign(w, {
        console: { log() {}, warn() {}, error() {} },
        database: {}, auth: {}, isFirebaseEnabled: true,
        ref: (_, path) => path, get: async path => snapshot(path),
        set: async (path, value) => { write(path, value); emit(); },
        update: async (path, values) => { for (const [key, value] of Object.entries(values)) write(`${path}/${key}`, value); emit(); },
        remove: async path => { write(path, null); emit(); },
        push: path => ({ key: `connection${++pushId}` }),
        onValue: (path, callback) => {
            const listener = { path, callback };
            listeners.add(listener);
            queueMicrotask(() => { if (listeners.has(listener)) notify(listener); });
            return () => listeners.delete(listener);
        },
        onChildAdded: () => () => {},
        onDisconnect: path => ({
            remove: async () => disconnects.set(path, true),
            cancel: async () => disconnects.delete(path)
        }),
        runTransaction: async (path, updater, options) => {
            transactions++;
            assert.equal(options.applyLocally, false);
            if (failTransaction) throw new Error('Permission denied');
            // Firebase can call an updater repeatedly; discarded retries must have no side effects.
            updater(clone(read(path)));
            const result = updater(clone(read(path)));
            if (result === undefined) return { committed: false, snapshot: snapshot(path) };
            write(path, result); emit();
            return { committed: true, snapshot: snapshot(path) };
        },
        setInterval: callback => { const id = ++timerId; timers.set(id, callback); return id; },
        clearInterval: id => timers.delete(id),
        setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        alert() {}, confirm: () => true,
        getCurrentUser: () => null,
    });
    vm.runInContext(source, dom.getInternalVMContext());
    const run = code => vm.runInContext(code, dom.getInternalVMContext());
    run(`databaseConnected = true; currentSessionPin = '123456'; myPlayerKey = 'p1';
        currentRole = 'player'; gameSessionRef = ref(database, 'sessions/123456');
        currentQuizData = { title: 'QA', questions: [{type:'multiple-choice',correct:1,timeLimit:20,options:['A','B','C','D'],text:'Question'}] };
        latestSession = ${JSON.stringify(room)};`);
    return { w, run, data, listeners, timers, disconnects, write, emit,
        snapshot, get room() { return read('sessions/123456'); },
        get transactions() { return transactions; },
        fail: () => { failTransaction = true; },
        flush: async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); },
        close: () => { listeners.clear(); timers.clear(); } };
}
function question(extra = {}) {
    return { status: 'question', currentQuestion: 0, questionStartTime: Date.now() - 1000,
        timeLimit: 20, questionType: 'type-answer', players: {
            p1: { nickname: 'Alice', score: 0, streak: 0 }, p2: { nickname: 'Bob', score: 100, streak: 1 }
        }, ...extra };
}

test('other answers, presence and reactions preserve typed text and question timer', async () => {
    const h = harness(question());
    h.run('bindPlayerSessionSyncPipeline()'); await h.flush();
    const input = h.w.document.getElementById('input-type-answer');
    input.value = 'Still typing my answer';
    const timers = h.timers.size;
    h.write('sessions/123456/answers/p2', { textAnswer: 'done', questionIndex: 0 }); h.emit();
    h.write('sessions/123456/reactions/test', { emoji: '👍' }); h.emit();
    assert.equal(input.value, 'Still typing my answer'); assert.equal(h.timers.size, timers);
    h.close();
});
test('sync button rebinding leaves exactly one room listener', () => {
    const h = harness(question());
    h.run('bindPlayerSessionSyncPipeline(); bindPlayerSessionSyncPipeline(); bindPlayerSessionSyncPipeline()');
    assert.equal(h.listeners.size, 1); h.close();
});
test('answer is committed once and is tagged with the active question', async () => {
    const h = harness(question());
    h.run('preparePlayerInputInterface(latestSession)');
    assert.equal(await h.run('submitPlayerAnswer({textAnswer:"test"})'), true);
    assert.equal(h.room.answers.p1.questionIndex, 0);
    assert.equal(await h.run('submitPlayerAnswer({textAnswer:"overwrite"})'), false);
    assert.equal(h.room.answers.p1.textAnswer, 'test'); h.close();
});
test('disconnected answer is not accepted and controls become retryable', async () => {
    const h = harness(question());
    h.run('preparePlayerInputInterface(latestSession); databaseConnected = false; hasAnsweredCurrent = true');
    assert.equal(await h.run('submitPlayerAnswer({textAnswer:"offline"})'), false);
    assert.equal(h.transactions, 0); assert.equal(h.room.answers, undefined);
    assert.equal(h.w.document.getElementById('input-type-answer').disabled, false); h.close();
});
test('write rejection clears the submitted lock and reports the real error', async () => {
    const h = harness(question());
    h.run('preparePlayerInputInterface(latestSession); hasAnsweredCurrent = true'); h.fail();
    assert.equal(await h.run('submitPlayerAnswer({textAnswer:"test"})'), false);
    assert.equal(h.run('hasAnsweredCurrent'), false);
    assert.match(h.w.document.getElementById('connection-status').textContent, /Permission denied/); h.close();
});
for (const [name, extra] of Object.entries({
    expired: { questionStartTime: Date.now() - 60000 },
    paused: { timerPaused: true },
    closed: { status: 'results' },
    'next question': { currentQuestion: 1 }
})) test(`answer cannot enter an ${name} round`, async () => {
    const h = harness(question(extra));
    h.run('playerActiveQuestionIndex = 0');
    assert.equal(await h.run('submitPlayerAnswer({optionIndex:1})'), false);
    assert.equal(h.room.answers, undefined); h.close();
});
test('refresh restores the same identity and confirmed answer without allowing resubmission', async () => {
    const h = harness(question({answers:{p1:{textAnswer:'done',questionIndex:0}}}));
    for (const [key,value] of Object.entries({player_session_pin:'123456',player_key:'p1',player_role:'player',player_nickname:'Alice'})) h.w.sessionStorage.setItem(key,value);
    await h.run('recoverPlayerSession()'); await h.flush();
    assert.equal(h.run('myPlayerKey'), 'p1'); assert.equal(h.run('hasAnsweredCurrent'), true);
    assert.equal(h.w.document.getElementById('player-waiting-msg').classList.contains('hidden'), false); h.close();
});
test('scoring is atomic and retrying or refreshing cannot award points twice', async () => {
    const h = harness(question({answers:{p1:{optionIndex:1,elapsedTime:2000,questionIndex:0}}}));
    await h.run('evaluateSystemScoringTransactions(1)');
    assert.equal(h.room.status, 'results'); assert.equal(h.room.players.p1.score, 900);
    assert.equal(h.room.totalAnswers, 1); assert.equal(h.room.totalCorrect, 1);
    assert.equal(h.room.players.p2.streak, 0);
    await h.run('evaluateSystemScoringTransactions(1)');
    assert.equal(h.room.players.p1.score, 900); assert.equal(h.room.players.p1.streak, 1);
    assert.equal(h.room.totalAnswers, 1); h.close();
});
test('stale round answer is ignored by scoring', async () => {
    const h = harness(question({answers:{p1:{optionIndex:1,elapsedTime:2000,questionIndex:-1}}}));
    await h.run('evaluateSystemScoringTransactions(1)');
    assert.equal(h.room.players.p1.score, 0); assert.equal(h.room.totalAnswers, 0); h.close();
});
test('result rendering uses the committed snapshot immediately', async () => {
    const h = harness(question({status:'results'}));
    h.room.players.p1.score = 900; h.room.players.p1.lastPointsEarned = 900; h.room.players.p1.wasCorrect = true;
    h.run(`renderPlayerResultPanel(${JSON.stringify(h.room)})`);
    assert.equal(h.w.document.getElementById('player-total-score').innerText, 900);
    assert.equal(h.w.document.getElementById('view-player-result').classList.contains('active'), true); h.close();
});
test('presence re-registers disconnect cleanup on reconnection and does not recreate a removed player', async () => {
    const h = harness(question()); h.run('startPresence()'); await h.flush();
    assert.ok(Object.keys(h.room.players.p1.connections).length);
    for (const path of h.disconnects.keys()) h.write(path, null);
    h.write('.info/connected', false); h.emit(); await h.flush();
    h.write('.info/connected', true); h.emit(); await h.flush();
    assert.ok(Object.keys(h.room.players.p1.connections).length);
    h.write('sessions/123456/players/p1', null);
    h.write('.info/connected', false); h.emit(); await h.flush();
    h.write('.info/connected', true); h.emit(); await h.flush();
    assert.equal(h.room.players.p1, undefined); h.close();
});
test('host timer uses shared deadline and retains pause after recovery', async () => {
    const h = harness(question({questionStartTime:Date.now()-12000}));
    h.run('currentRole = "host"; runTimerCountdown()'); await h.flush();
    assert.ok(h.run('timeLeft') <= 8);
    h.write('sessions/123456/timerPaused', true); h.write('sessions/123456/pausedRemaining', 6500); h.emit();
    assert.equal(h.run('timeLeft'), 7);
    h.run('runTimerCountdown()'); await h.flush(); assert.equal(h.run('timeLeft'), 7); h.close();
});
test('leaving clears room listeners, presence and timers', async () => {
    const h = harness(question());
    h.run('bindPlayerSessionSyncPipeline(); startPresence()'); await h.flush();
    h.run('purgeActiveListeners()'); await h.flush();
    assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
    assert.equal(h.run('currentRole'), null); h.close();
});

for (const [type, config, answer, points] of [
    ['multiple-choice', {correct:1}, {optionIndex:1}, 900],
    ['true-false', {correct:0}, {optionIndex:0}, 900],
    ['type-answer', {answerText:'Copilot'}, {textAnswer:'copilot'}, 900],
    ['number-guess', {targetNumber:42}, {numberAnswer:42.1}, 900],
    ['poll', {}, {optionIndex:1}, 0],
    ['jumbled-prompt', {words:['a','b','a']}, {sequence:['a','b','a']}, 900],
    ['speed-math', {equation:'goal, context'}, {textAnswer:'goal context'}, 964]
]) test(`${type} scoring awards the expected points`, async () => {
    const h = harness(question({answers:{p1:{...answer,elapsedTime:2000,questionIndex:0}}}));
    h.run(`currentQuizData.questions[0] = ${JSON.stringify({type,timeLimit:20,...config})}`);
    await h.run(`evaluateSystemScoringTransactions(${config.correct ?? 'undefined'})`);
    assert.equal(h.room.players.p1.score,points); assert.equal(h.room.players.p1.wasCorrect,true); h.close();
});
test('jumbled words can be moved repeatedly without losing duplicate words', () => {
    const h = harness(question({questionType:'jumbled-prompt',questionWords:['a','a','b','c']}));
    h.run('preparePlayerInputInterface(latestSession)');
    const available=h.w.document.getElementById('player-jumbled-available');
    const constructed=h.w.document.getElementById('player-jumbled-constructed');
    const a=[...available.children].filter(el=>el.innerText==='a');
    a[0].click(); a[1].click(); a[0].click();
    assert.deepEqual([...constructed.children].map(el=>el.innerText),['a']);
    a[0].click(); a[0].click(); a[0].click();
    assert.deepEqual([...constructed.children].map(el=>el.innerText),['a','a']); h.close();
});
test('double start cannot erase existing answers or restart the question', async () => {
    const h = harness(question({answers:{p1:{textAnswer:'done',questionIndex:0}}}));
    await assert.rejects(h.run('executeQuestionBroadcast()'),/already moved/);
    assert.equal(h.room.answers.p1.textAnswer,'done'); h.close();
});
