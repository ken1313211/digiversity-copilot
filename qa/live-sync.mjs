// Opt-in integration test: creates one isolated QA room, then removes only that room.
// Uses the application's actual code and Firebase SDK against its configured database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { initializeApp, deleteApp } from 'firebase/app';
import * as dbAPI from 'firebase/database';

if (!process.argv.includes('--live')) throw new Error('Pass --live to create a disposable Firebase QA room.');
const configSource = fs.readFileSync('firebase-config.js', 'utf8');
const config = vm.runInNewContext('(' + configSource.match(/const firebaseConfig = (\{[\s\S]*?\});/)[1] + ')');
const source = fs.readFileSync('app.js', 'utf8').replace(/^import\s*\{[\s\S]*?\}\s*from\s*"\.\/firebase-config\.js";/, '');
const clients = [];
const playerCount = Number(process.argv.find(arg=>arg.startsWith('--players='))?.split('=')[1] || 3);
if (!Number.isInteger(playerCount) || playerCount < 3 || playerCount > 40) throw new Error('Use --players=3 through --players=40.');
const quiz = { title: 'QA disposable sync test', questions: [
    { type: 'type-answer', text: 'QA: type copilot', answerText: 'copilot', timeLimit: 120 },
    { type: 'multiple-choice', text: 'QA: select B', options: ['A','B','C','D'], correct: 1, timeLimit: 120 }
] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await check()) return; await sleep(100); }
    throw new Error('Timed out: ' + label);
}
async function client(role, pin, key) {
    const app = initializeApp(config, 'qa-' + role + '-' + Date.now() + '-' + clients.length);
    const database = dbAPI.getDatabase(app);
    const dom = new JSDOM(fs.readFileSync('index.html','utf8'), {url:'http://localhost/qa/',runScripts:'outside-only'});
    const w = dom.window;
    const add = w.document.addEventListener.bind(w.document);
    w.document.addEventListener = (event, handler, ...rest) => event === 'DOMContentLoaded' ? undefined : add(event, handler, ...rest);
    w.HTMLMediaElement.prototype.play = () => Promise.resolve();
    Object.assign(w, dbAPI, { database, auth:{}, isFirebaseEnabled:true, getCurrentUser:()=>null,
        console:{ log(){}, warn(){}, error(...args){ console.error(role, ...args); } }, alert:console.error });
    vm.runInContext(source, dom.getInternalVMContext());
    const run = code => vm.runInContext(code, dom.getInternalVMContext());
    const c = {app,database,dom,w,run}; clients.push(c);
    run(`currentRole = ${JSON.stringify(role)}; currentSessionPin = ${JSON.stringify(pin)};
        myPlayerKey = ${JSON.stringify(key)}; currentQuizData = ${JSON.stringify(quiz)};
        gameSessionRef = ref(database, 'sessions/' + currentSessionPin); setupConnectionMonitoring();`);
    await until(()=>run('databaseConnected'), role+' database connection');
    return c;
}
let pin, ownerRef, marker;
const watchdog = setTimeout(()=>{console.error('QA watchdog expired. Check for QA room',pin);process.exit(1);},150000);
try {
    const host = await client('host', null, null);
    await host.run(`initializeLiveRoom(${JSON.stringify(quiz)})`);
    pin = host.run('currentSessionPin');
    ownerRef = dbAPI.ref(host.database, 'sessions/' + pin);
    marker = 'qa-' + Date.now();
    await dbAPI.update(ownerRef, {qaOwner:marker});
    console.log('Created disposable QA room',pin);
    const players = [];
    for (let i=1;i<=playerCount;i++) {
        const key='qa-player-'+i;
        const p = await client('player',pin,key);
        p.run('setupPlayerParticipationWorkflow()');
        p.w.document.getElementById('input-pin').value=pin;
        p.w.document.getElementById('input-nickname').value='QA Player '+i;
        p.w.document.getElementById('form-join').dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));
        await until(()=>p.w.sessionStorage.getItem('player_key'), 'player join form '+i);
        players.push(p);
    }
    await until(()=>host.w.document.getElementById('player-count').innerText == playerCount, 'all online players');
    console.log('PASS',playerCount,'independent clients joined and presence reached host');
    await host.run('executeQuestionBroadcast()');
    await until(()=>players.every(p=>p.run('playerActiveQuestionIndex')===0),'question broadcast');
    const p1=players[0], p2=players[1], p3=players[2];
    p1.w.document.getElementById('input-type-answer').value='draft preserved';
    assert.equal(await p2.run('submitPlayerAnswer({textAnswer:"copilot"})'),true);
    await until(()=>host.run('Object.keys(hostAnswersMap).length')===1,'answer delivered');
    assert.equal(p1.w.document.getElementById('input-type-answer').value,'draft preserved');
    console.log('PASS real-time answer delivery preserves another player draft');
    dbAPI.goOffline(p3.database);
    await until(()=>!p3.run('databaseConnected'),'offline indication');
    assert.equal(await p3.run('submitPlayerAnswer({textAnswer:"offline"})'),false);
    dbAPI.goOnline(p3.database);
    await until(()=>p3.run('databaseConnected'),'reconnect');
    await until(async()=>!!(await dbAPI.get(ownerRef)).val().players[p3.run('myPlayerKey')].connections,'restored presence');
    assert.equal(await p3.run('submitPlayerAnswer({textAnswer:"copilot"})'),true);
    console.log('PASS disconnect blocks answer; reconnect restores presence and submission');
    await dbAPI.update(ownerRef,{timerPaused:true,pausedRemaining:60000});
    await until(()=>p1.run('latestSession.timerPaused'),'pause sync');
    assert.equal(await p1.run('submitPlayerAnswer({textAnswer:"copilot"})'),false);
    await dbAPI.update(ownerRef,{timerPaused:false,questionStartTime:Date.now()-60000,pausedRemaining:null});
    await until(()=>!p1.run('latestSession.timerPaused'),'resume sync');
    assert.equal(await p1.run('submitPlayerAnswer({textAnswer:"copilot"})'),true);
    const burstStarted = Date.now();
    const burst = await Promise.all(players.slice(3).map(p=>p.run('submitPlayerAnswer({textAnswer:"copilot"})')));
    assert.ok(burst.every(Boolean), 'concurrent submissions all acknowledged');
    console.log('PASS concurrent answer burst:',burst.length,'answers in',Date.now()-burstStarted,'ms');
    await host.run('concludeQuestionEvaluation()');
    await until(()=>players.every(p=>p.w.document.getElementById('view-player-result').classList.contains('active')),'all result screens');
    const scored=(await dbAPI.get(ownerRef)).val();
    assert.equal(scored.totalAnswers,playerCount); assert.equal(scored.totalCorrect,playerCount);
    assert.ok(Object.values(scored.players).every(p=>p.score>0 && p.wasCorrect));
    await host.run('concludeQuestionEvaluation()');
    assert.deepEqual((await dbAPI.get(ownerRef)).val().players,scored.players);
    console.log('PASS pause/resume, atomic results and duplicate scoring protection');
    await host.run('presentHostLeaderboardView();');
    await host.run('hostActiveQuestionIndex = 1; executeQuestionBroadcast()');
    await until(()=>players.every(p=>p.run('playerActiveQuestionIndex')===1),'next round broadcast');
    assert.equal(await p1.run('submitPlayerAnswer({optionIndex:1})'),true);
    // Simulate page refresh with a new SDK connection and only persisted player identity.
    p1.run('purgeActiveListeners()');
    const playerKey=p1.run('myPlayerKey');
    const refreshed = await client('player',pin,playerKey);
    for (const [key,value] of Object.entries({player_session_pin:pin,player_key:playerKey,player_role:'player',player_nickname:'QA Player 1'})) refreshed.w.sessionStorage.setItem(key,value);
    await refreshed.run('recoverPlayerSession()');
    await until(()=>refreshed.run('hasAnsweredCurrent'),'refresh recovers committed answer');
    assert.equal(await refreshed.run('submitPlayerAnswer({optionIndex:0})'),false);
    console.log('PASS next question and refresh recovery without duplicate answer');
    await host.run('concludeQuestionEvaluation();');
    await host.run('presentHostLeaderboardView();');
    await until(()=>[p2,p3,refreshed].every(p=>p.w.document.getElementById('view-player-leaderboard').classList.contains('active')),'final rankings');
    console.log('PASS final leaderboard delivered to all active players');
} finally {
    for (const c of clients) c.run('purgeActiveListeners()');
    if (ownerRef && marker) {
        const result=await clients[0].run(`transactRoom(ref(database, 'sessions/${pin}'), room => room?.qaOwner === ${JSON.stringify(marker)} ? null : undefined)`);
        console.log('Removed owned QA room:',result.committed);
        assert.equal((await dbAPI.get(ownerRef)).exists(),false,'QA room cleanup');
    }
    for (const c of clients) { dbAPI.goOffline(c.database); await deleteApp(c.app); c.dom.window.close(); }
    clearTimeout(watchdog);
}
