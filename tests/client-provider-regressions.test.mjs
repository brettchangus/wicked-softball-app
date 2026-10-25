import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import TournamentProjection from '../assets/projections.js';
// Normalized to LF: Windows checkouts (core.autocrlf) have CRLF, and the extraction regexes below
// match line ends with \n.
const source = fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function client(name, globals={}) {
  const start=source.indexOf(`function ${name}(`);
  assert.ok(start>=0);
  const tail=source.slice(start), end=tail.search(/^}/m)+1;
  return vm.runInNewContext(`(${tail.slice(0,end)})`,{TournamentProjection,bracketGameData:{},POOL_KEYS:[],SEEDING_RULES:null,projectionSnapshot:null,bracketEntryPool:()=>null,...globals});
}
test('empty placement roots allow the bracket fallback renderer',()=>{
  const render=client('renderPlacementBracket',{document:{getElementById:()=>({innerHTML:'existing'})}});
  assert.equal(render('panel',{frame:[{gameNo:1}],placementGames:{}},[],0),false);
});
test('placement brackets render provider seed labels instead of replacing them with TBD',()=>{
  const panel={innerHTML:''};
  const render=client('renderPlacementBracket',{
    document:{getElementById:()=>panel}, bracketGameData:{championship:[]}, bracketResultOf:()=>null,
    bracketTeam:(id,name)=>({id,name}), btSlot:()=>'', _normStatus:()=>null,
    bktGameHeader:()=>'', fmtFrameTime:()=>'', trophyIcon:()=>'', bracketTrophyPlace:()=>1,
    historyEsc:v=>String(v).replaceAll('<','&lt;'), watchBracketTreeLayout(){}
  });
  render('panel',{level:'championship',label:'Championship',placementGames:{championship:'B1'},
    frame:[{gameNo:1,round:1,topName:'Bracket A 1st Place',botName:'Pool B 2nd Place'}]},[],1);
  assert.match(panel.innerHTML,/Bracket A 1st Place/);
  assert.match(panel.innerHTML,/Pool B 2nd Place/);
  assert.doesNotMatch(panel.innerHTML,/>TBD</);
});
test('plain frame fallback keeps assigned teams and provider seed labels',()=>{
  const panel={innerHTML:''};
  const render=client('renderFrameBracket',{
    document:{getElementById:()=>panel}, BRACKETS:[{level:'championship',placementGames:{}}],
    bracketResultOf:()=>null, bracketTeam:(id,name)=>({id,name}), bracketWinner:()=>null,
    bracketGameScore:()=>null, btSlot:team=>`<div>${team.name}</div>`, bktGameHeader:()=>'',
    fmtFrameTime:()=>'', trophyIcon:()=>'', historyEsc:v=>String(v).replaceAll('<','&lt;')
  });
  assert.equal(render('panel',[{gameNo:1,round:1,topId:'wicked',topName:'[1] Wicked Elite',
    botId:null,botName:'Bracket A 1st Place'}],[],1,'championship'),true);
  assert.match(panel.innerHTML,/\[1\] Wicked Elite/);
  assert.match(panel.innerHTML,/Bracket A 1st Place/);
});
test('placement trees fit wrapped cards and connect their centers after sizing changes',()=>{
  const card=(game,row,left,height)=>({dataset:{game:String(game),row:String(row)},style:{},offsetLeft:left,offsetWidth:220,offsetHeight:height});
  const cards=[card(1,0,0,164),card(2,1,0,240),card(3,0.5,285,190)];
  const paths=cards.slice(0,2).map(c=>({dataset:{from:c.dataset.game,to:'3'},setAttribute(k,v){this[k]=v;}}));
  const svg={setAttribute(k,v){this[k]=v;},querySelectorAll:()=>paths};
  let visible=false;
  const tree={style:{},getClientRects:()=>visible?[{}]:[],querySelectorAll:()=>cards,querySelector:()=>svg};
  const layout=client('layoutBracketTree');
  layout(tree);
  assert.equal(tree.style.height,undefined,'hidden tabs wait until they can be measured');
  visible=true;
  layout(tree);
  const center=c=>parseFloat(c.style.top)+c.offsetHeight/2;
  assert.equal(center(cards[2]),(center(cards[0])+center(cards[1]))/2);
  assert.ok(parseFloat(cards[1].style.top)>parseFloat(cards[0].style.top)+cards[0].offsetHeight);
  paths.forEach((p,i)=>assert.equal(p.d,`M220,${center(cards[i])} H252.5 V${center(cards[2])} H285`));
  cards[0].offsetHeight=310; // A wrapped team name or larger font changes the card after first paint.
  layout(tree);
  cards.forEach(c=>assert.ok(parseFloat(c.style.top)+c.offsetHeight<parseFloat(tree.style.height)));
  assert.equal(Number(svg.height),parseFloat(tree.style.height));
  assert.equal(center(cards[2]),(center(cards[0])+center(cards[1]))/2);
});
test('a pre-event hourly check does not trigger the live-score stale warning',()=>{
  const stale=client('scoreDataMayBeStale');
  const checked='2026-09-16T01:05:00Z', now=Date.parse('2026-09-16T02:00:00Z');
  const days=['2026-09-19','2026-09-20'];
  assert.equal(stale(checked,days,'2026-09-20','2026-09-15',now),false);
  assert.equal(stale(checked,days,'2026-09-20','2026-09-19',now),true);
  assert.equal(stale(checked,days,'2026-09-20','2026-09-21',now),false);
  assert.equal(stale(null,days,'2026-09-20','2026-09-19',now),false);
});
test('venue keeps fallback coordinates and city when geocoding fails, and accepts published coordinates',()=>{
  const resolve=client('resolveTournamentVenue');
  const fallback={lat:37,lon:-121,city:'Manteca'};
  const venue=resolve(fallback,{}, {name:'Park',lat:null,lon:null,city:''});
  assert.equal(venue.lat,37); assert.equal(venue.lon,-121); assert.equal(venue.city,'Manteca');
  const published=resolve(fallback,venue,{lat:38,lon:-122});
  assert.equal(published.lat,38);
  assert.equal(resolve({},published,{lat:null,lon:null}).lat,38);
  assert.equal(resolve({}, {}, {name:'Different event'}).lat,undefined);
});
test('season list classifies nonactive tournaments by calendar dates, not legacy status',()=>{
  const classify=client('seasonRowStatus',{ SEASON_OVER:false,
    seasonCalendarDates:row=>row.startDate ? row : null, pacificTodayKey:()=> '2026-09-14' });
  assert.equal(classify({startDate:'2026-09-01',endDate:'2026-09-02',status:'fut'},false),'done');
  assert.equal(classify({startDate:'2026-09-20',endDate:'2026-09-21',status:'done'},false),'fut');
  assert.equal(classify({startDate:'2026-09-14',endDate:'2026-09-15'},false),'neutral');
  assert.equal(classify({dates:'TBA',status:'now'},false),'neutral');
  assert.equal(classify({dates:'TBA'},true),'now');
});
test('the root canonical URL keeps other query params and adds no marker of its own',()=>{
  const ctx=g=>client('defaultContextUrl',{ location:g, URLSearchParams });
  const catalog={defaultTeamKey:'another-team',teams:{'another-team':{defaultSeasonKey:'fall-2026',seasons:{'fall-2026':{}}}}};
  assert.equal(ctx({search:'?test=1',hash:'#schedule'})(catalog),
    '/teams/another-team/seasons/fall-2026?test=1#schedule');
  // A bare / must not create a trailing '?' — the canonical URL is what gets shared.
  assert.equal(ctx({search:'',hash:''})(catalog),'/teams/another-team/seasons/fall-2026');
  assert.equal(ctx({search:'?team=x&season=y',hash:''})(catalog),'/teams/another-team/seasons/fall-2026');
  assert.equal(ctx({search:'',hash:''})(null),null);
  assert.equal(ctx({search:'',hash:''})({defaultTeamKey:'another-team',teams:{'another-team':{seasons:{}}}}),null);
});
test('root startup resolves the catalog without restarting the loader',async()=>{
  const catalog={defaultTeamKey:'another-team',teams:{'another-team':{defaultSeasonKey:'fall-2026',seasons:{'fall-2026':{}}}}};
  const location={pathname:'/',search:'?test=1',hash:'#schedule'};
  const routeContext={teamKey:'wicked-10b',seasonKey:'summer-2026',eventKey:null};
  const stored=new Map([
    ['gameNotifs:another-team:fall-2026','["game-1"]'],
    ['notifiedGames:another-team:fall-2026','["game-2"]'],
  ]);
  const state={ ROOT_DEFAULT_REQUEST:true, APP_CONTEXT:{...routeContext}, routeContext,
    GAME_NOTIFS_KEY:'gameNotifs:wicked-10b:summer-2026',
    NOTIFIED_GAMES_KEY:'notifiedGames:wicked-10b:summer-2026',
    TEAM_STATS_KEY:'teamStats:wicked-10b:summer-2026',
    SEASON_ARCHIVE_CACHE_KEY:'seasonArchive:wicked-10b:summer-2026',
    gameNotifs:new Set(), notifiedGames:new Set() };
  let replaced='', liveCalls=0, syncCalls=0;
  const globals={...state,location,URLSearchParams,AbortSignal,
    history:{state:null,replaceState:(_state,_title,url)=>{replaced=url;}},
    fetch:async()=>({ok:true,json:async()=>catalog}),
    defaultContextUrl:client('defaultContextUrl',{location,URLSearchParams}),
    contextStorageKey:name=>`${name}:${routeContext.teamKey}:${routeContext.seasonKey}`,
    localStorage:{getItem:key=>stored.get(key)||null},
    Notification:{permission:'granted'},
    syncPushSubscription:()=>{syncCalls++;}, fetchLive:()=>{liveCalls++;}};
  const start=source.indexOf('async function startDashboard(');
  const end=source.indexOf('\n}',start)+2;
  await vm.runInNewContext(`(${source.slice(start,end)})`,globals)();
  assert.equal(replaced,'/teams/another-team/seasons/fall-2026?test=1#schedule');
  assert.equal(globals.ROOT_DEFAULT_REQUEST,false);
  assert.equal(globals.APP_CONTEXT.teamKey,'another-team');
  assert.deepEqual([...globals.gameNotifs],['game-1']);
  assert.deepEqual([...globals.notifiedGames],['game-2']);
  assert.equal(liveCalls,1);
  assert.equal(syncCalls,1);
});
test('static-preview root shows coming soon when the catalog endpoint is missing',async()=>{
  let shown=false, finished=false, liveCalls=0;
  const globals={
    ROOT_DEFAULT_REQUEST:true, AbortSignal,
    fetch:async()=>({ok:false,status:404}),
    defaultContextUrl:()=>null,
    renderComingSoon:snap=>{shown=!!snap.comingSoon;},
    finishInitialLoad:()=>{finished=true;},
    fetchLive:()=>{liveCalls++;},
  };
  const start=source.indexOf('async function startDashboard(');
  const end=source.indexOf('\n}',start)+2;
  await vm.runInNewContext(`(${source.slice(start,end)})`,globals)();
  assert.equal(shown,true);
  assert.equal(finished,true);
  assert.equal(liveCalls,0);
  assert.equal(globals.ROOT_DEFAULT_REQUEST,true);
});
test('static-preview root shows coming soon for a successful empty catalog',async()=>{
  let shown=false, liveCalls=0;
  const globals={
    ROOT_DEFAULT_REQUEST:true, AbortSignal,
    fetch:async()=>({ok:true,status:200,json:async()=>({teams:{}})}),
    defaultContextUrl:()=>null,
    renderComingSoon:snap=>{shown=!!snap.comingSoon;},
    finishInitialLoad:()=>{},
    fetchLive:()=>{liveCalls++;},
  };
  const start=source.indexOf('async function startDashboard(');
  const end=source.indexOf('\n}',start)+2;
  await vm.runInNewContext(`(${source.slice(start,end)})`,globals)();
  assert.equal(shown,true);
  assert.equal(liveCalls,0);
});
test('the public season picker labels both completed and legacy archived seasons',()=>{
  const switcher=source.slice(source.indexOf('function renderContextSwitcher('),source.indexOf('function renderContextSwitcher(')+1800);
  assert.match(switcher,/\['completed','archived'\]\.includes\(season\.status\)\?' · Completed':''/);
});
test('mixed official ranks sort consistently across all input permutations',()=>{
  const sort=client('sortStandingsTeams');
  const a={id:'a',officialRank:1,w:1}, b={id:'b',officialRank:null,w:2}, c={id:'c',officialRank:2,w:3};
  for(const rows of [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]]) {
    assert.equal(sort(rows).map(t=>t.id).join(','),'c,b,a');
  }
  b.officialRank=3;
  assert.equal(sort([c,b,a]).map(t=>t.id).join(','),'a,c,b');
  assert.equal(sort([{id:'z',w:0},{id:'a',w:0}]).map(t=>t.id).join(','),'a,z');
  assert.equal(sort([{id:'opponent',w:0,officialRank:1},{id:'wicked',w:0,officialRank:2,me:true}])
    .map(t=>t.id).join(','),'opponent,wicked');
  assert.equal(sort([{id:'opponent',w:1,officialRank:1},{id:'wicked',w:0,officialRank:2,me:true}])
    .map(t=>t.id).join(','),'opponent,wicked');
});

test('standings put Wicked first only within unresolved seeding ties',()=>{
  const sort=client('sortStandingsTeams');
  const wicked={id:'wicked',me:true,w:1,l:1,ra:5,rf:8};
  const tied={id:'a-tied',w:1,l:1,ra:5,rf:8};
  const better={id:'better',w:1,l:1,ra:2,rf:8};
  assert.equal(sort([tied,wicked,better], 'officialPoolRank', true).map(t=>t.id).join(','),'better,wicked,a-tied');
  const posted=[tied,wicked,better].map((t,i)=>({...t,officialPoolRank:i+1}));
  assert.equal(sort(posted, 'officialPoolRank', true).map(t=>t.id).join(','),'a-tied,wicked,better');
});

test('Wicked display preference respects win percentage and configured tiebreakers',()=>{
  const sort=client('sortStandingsTeams',{
    SEEDING_RULES:{verified:true,primary:'winPercentage',tiebreakers:['runsAllowed','runsScored']},
    projectionSnapshot:{pools:{},results:{}}
  });
  const rows=[
    {id:'wicked',me:true,w:3,l:3,ra:5,rf:8},
    {id:'a-tied',w:1,l:1,ra:5,rf:8},
    {id:'better-record',w:2,l:0,ra:20,rf:0},
    {id:'better-ra',w:1,l:1,ra:2,rf:0},
    {id:'better-rf',w:1,l:1,ra:5,rf:9}
  ];
  assert.equal(sort(rows,'officialPoolRank',true).map(t=>t.id).join(','),
    'better-record,better-ra,better-rf,wicked,a-tied');
});

test('a linked GameChanger record opens the app route and an absent record stays blank',()=>{
  const record=client('gameChangerRecordHtml',{
    GAMECHANGER_RECORDS:{ opponent:{ win:5, loss:5, tie:1 } },
    GAMECHANGER_TEAMS:{ opponent:'https://web.gc.com/teams/example-profile?pid=Copy' },
    gameChangerAppUrl:url=>`https://web.gc.com/teams/${/\/teams\/([^/?#]+)/.exec(url)?.[1]}/team`,
  });
  assert.match(record('opponent'), /href="https:\/\/web\.gc\.com\/teams\/example-profile\/team"/);
  assert.match(record('opponent'), /target="blank"/);
  assert.match(record('opponent'), />5–5–1<\/a>/);
  assert.equal(record('missing'), '—');
});

test('an assigned multi-tier bracket frame names our next game and its possible opponents',()=>{
  // NorCal Gold/Silver/Bronze: the frame is filled in Saturday night, before any live bracket games.
  const gold={ level:'gold', frame:[
    { gameNo:2, topSeed:3, topId:'red', topName:'Burlingame Red', botSeed:6, botId:'rp', botName:'Rohnert Park' },
    { gameNo:4, time:'2026-10-18T13:15:00', topGame:2, botSeed:2, botId:'ours', botName:'Wicked Elite' },
  ] };
  const globals={ BRACKET_ONLY:false, MY_ID:'ours', BRACKETS:[{ level:'silver', frame:[{ gameNo:1, topId:'x', botId:'y' }] }, gold, { level:'bronze', frame:[] }],
    BRACKET_SEEDED:{}, bracketGameData:{} };
  globals.bracketResultOf=()=>null;
  globals.projectBracketSlot=client('projectBracketSlot',globals);
  globals.projectedGameFrom=client('projectedGameFrom',globals);
  const next=client('wickedProjectedNextGame',globals)();
  assert.equal(next.level,'gold');
  assert.equal(next.game.gameNo,4);
  assert.equal(next.wSeed,2);
  assert.equal(next.wickedIsTop,false);
  assert.deepEqual({...next.opp},{ label:'Winner of G2' });
  const candidates=client('bracketSlotCandidates',globals)(next.level,next.oppSeed,null,null,next.oppGame);
  assert.deepEqual([...candidates.map(t=>t.id)],['red','rp']);
});

test('bracket slots offer an inline Scout link instead of the GameChanger logo',()=>{
  const scout=client('bracketScoutLinkHtml',{ SCOUT_SUMMARIES:[{ id:'opp', name:'Burlingame <Red>' }], jsArg:JSON.stringify,
    historyEsc:v=>String(v).replace(/</g,'&lt;').replace(/>/g,'&gt;') });
  assert.equal(scout('other'), '');
  assert.match(scout('opp'), /^<span class="bt-scout-sep" aria-hidden="true">&nbsp;·&nbsp;<\/span><a href="#" role="button" class="team-link bt-scout"/);
  assert.match(scout('opp'), /openScoutingReport\("opp",contextQuery\(\),"Burlingame <Red>"\);return false/);
  assert.match(scout('opp'), /aria-label="Scouting report for Burlingame &lt;Red&gt;">Scout<\/a>$/);
  const slot=client('btSlot',{ MY_ID:'ours', SISTER_ID:null, jsArg:JSON.stringify, historyEsc:String, bracketScoutLinkHtml:id=>`[scout ${id}]` });
  const html=slot({ id:'opp', name:'Burlingame Red' }, 2, null);
  // Inline <a> (not an inline-block <button>) with no space before the link, so a wrapped name keeps
  // "Scout" on its last line.
  assert.match(html, /<a href="#" role="button" class="team-link"[^>]*>#2 Burlingame Red<\/a>\[scout opp\]<\/span>/);
  assert.doesNotMatch(html, /gc-team-link/);
});

test('Next Game leaves GameChanger links in the record column',()=>{
  const render=client('nextTeamNameHtml',{
    gameChangerLinkHtml:id=>`<a class="gc-team-link" href="/${id}">GC</a>`,
    gameChangerLocationHtml:(id,name)=>id==='wicked' && name==='Wicked Elite - Agar'
      ? '<span class="team-location">Agar · Example City, CA</span>' : ''
  });
  assert.equal(render('<a class="nxt-link">Wicked Elite</a>', 'wicked', 'Wicked Elite - Agar'),
    '<span class="nxt-team-name-line"><a class="nxt-link">Wicked Elite</a></span><span class="team-location">Agar · Example City, CA</span>');
  assert.match(source, /\.nxt-team-name-line\{display:block;\}/);
});

test('coach and GameChanger location share one escaped secondary line',()=>{
  const render=client('gameChangerLocationHtml',{
    GAMECHANGER_LOCATIONS:{ wicked:{ city:'Redwood <City>', state:'CA' } },
    // A team the server resolved (admin edits → provider → GameChanger) uses those parts as-is.
    TEAM_DISPLAY:{ resolved:{ name:'Storm', coach:'', city:'Reno', state:'NV', providerName:'Storm 10B - Reno' },
      edited:{ name:'Storm', coach:'Reyes', city:'', state:'', providerName:'Delta Storm - Alvarez' } },
    splitRosterName:client('splitRosterName'), MY_ID:'wicked', AST_TEAM_NAME:'Wicked Elite-Agar',
    historyEsc:value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;')
  });
  assert.equal(render('wicked', 'Wicked Elite - Agar'), '<span class="team-location">Agar · Redwood &lt;City&gt;, CA</span>');
  assert.equal(render('wicked', 'Wicked Elite'), '<span class="team-location">Agar · Redwood &lt;City&gt;, CA</span>');
  assert.equal(render('missing', 'Example Outlaws-Avina'), '<span class="team-location">Avina</span>');
  assert.equal(render('missing'), '');
  assert.equal(render('resolved', 'Storm 10B - Reno'), '<span class="team-location">Reno, NV</span>');
  assert.equal(render('edited', 'Storm - Reyes'), '<span class="team-location">Reyes</span>');
});

test('short names and badge colors resolve a team from the tournament being drawn',()=>{
  const display={ edited:{ name:'Nor-Cal Storm', providerName:'San Bruno Storm 10B - Lee' } };
  const short=client('shortTeam',{ TEAM_DISPLAY:display });
  assert.equal(short('Nor-Cal Storm - Lee','edited'),'Nor-Cal Storm');   // not re-split on the dash
  assert.equal(short('Wicked 10B - Example City','unknown'),'Wicked');
  assert.equal(short('Example Blaze 10B'),'Example Blaze');
  const color=client('teamBadgeColor',{ TEAM_DISPLAY:display });
  assert.equal(color('edited','Nor-Cal Storm - Lee'),color('edited','San Bruno Storm 10B - Lee'));          // follows the provider name
  // A past tournament passes its own map, so the live tournament's edits never apply to it.
  assert.equal(color('edited','Nor-Cal Storm - Lee',{}),color('edited','Nor-Cal Storm - Lee'));
  assert.equal(color('edited','Nor-Cal Storm - Lee',{ edited:{ providerName:'Belmont Blast' } }),color('edited','Nor-Cal Storm - Lee'));
});

test('the level badge is judged against the name on screen, not the provider name',()=>{
  // `level` is the class the server resolved for each team (lib/opponents.js teamClassSource, else
  // the class in the provider's name); the page only decides whether the name on screen says it.
  const TEAM_DISPLAY={
    magic:{ name:'Example Magic', providerName:"Example Magic 10C - Fall 2026 (Coach Five)", level:'C' },
    smoke:{ name:'Livermore Smoke', providerName:'Livermore Smoke 10uC', level:'C' },
    kept:{ name:'Example Blaze 10B', providerName:'Example Blaze 10B - Sullivan', level:'B' },
    red:{ name:'Burlingame Red', providerName:'Burlingame 10U Red' },
    queens:{ name:'Example Queens', providerName:'Example Queens Fall Ball 10U (1)', level:'C' },
    up:{ name:'Playing Up 10B', providerName:'Playing Up 10B', level:'C' },
    rec:{ name:'Storm', providerName:'Storm 10C - Lee', level:'Rec' },
  };
  const globals={ TEAM_DISPLAY, splitRosterName:client('splitRosterName') };
  globals.nameHasLevel=vm.runInNewContext(
    source.match(/const nameHasLevel = (.*);\n/)[1], globals);
  const badge=client('teamLevelBadge',globals);
  // The edited name no longer shows the class the provider's name carried.
  assert.equal(badge('magic','Example Magic - Coach Five'),'C');
  assert.equal(badge('smoke','Livermore Smoke - Von Glahn'),'C');
  assert.equal(badge('queens','Example Queens - Mancias'),'C');
  assert.equal(badge('rec','Storm - Lee'),'Rec');
  // Already on screen, or no class: no badge.
  assert.equal(badge('kept','Example Blaze 10B - Sullivan'),'');
  assert.equal(badge('red','Burlingame Red - Fleming'),'');
  // A C team whose name says 10B (it plays in the B bracket) is badged with its real class.
  assert.equal(badge('up','Playing Up 10B'),'C');
  // No server entry (the local fixture): the name on screen is the provider's own, so no badge.
  assert.equal(badge('unknown','Marin Tremors 10C Black'),'');
  assert.equal(badge('unknown','Marin Tremors 10U Black'),'');
});

// The page no longer works out a team's class itself: POOLS keeps only `level`, which decides
// bracket membership; the class shown comes from the snapshot's teamDisplay.
test('pool teams keep their bracket level when a snapshot is applied',()=>{
  const mapping=source.match(/teams: (\(p\.teams \|\| \[\]\)\.map\(t => \(\{.*\}\)\)),\n/);
  assert.ok(mapping, 'pool team mapping');
  const teams=vm.runInNewContext(mapping[1],{ MY_ID:'mine', SISTER_ID:null,
    p:{ teams:[{ id:'mine', name:'Ours', sr:'0-0', registeredLevel:'B' },
      { id:'opp', name:'Storm', sr:'4-1', level:'B', norcalClass:'C', registeredLevel:'C', city:'Reno' }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(teams)),[
    { id:'mine', name:'Ours', sr:'0-0', me:true, sister:false },
    { id:'opp', name:'Storm', sr:'4-1', level:'B', me:false, sister:false }]);
});

test('standings derive run totals from completed games when the provider omits PF and PA',()=>{
  const totals=client('standingsRunTotals');
  assert.deepEqual({...totals({win:2,loss:1,tie:0},{rf:17,ra:9})},{rf:17,ra:9});
  assert.deepEqual({...totals({PF:0,PA:0},{rf:17,ra:9})},{rf:0,ra:0});
  assert.deepEqual({...totals({PF:12,PA:8},{rf:17,ra:9},true)},{rf:17,ra:9});
});

test('bracket dispatcher renders the frame when placement roots are empty',()=>{
  const panel={innerHTML:''};
  const placement=client('renderPlacementBracket',{document:{getElementById:()=>panel}});
  const draw=client('buildBrackets',{
    BRACKET_ONLY:false, BRACKETS:[{level:'gold',size:2,placementGames:{},frame:[{gameNo:1}]}],
    PROJECTION_UNSUPPORTED:true, renderPlacementBracket:placement,
    renderFrameBracket:()=>{panel.innerHTML='Assigned team vs opponent';return true;},
    renderSEBracket:()=>assert.fail('frame should render'), buildWickedScenarios:()=>{}
  });
  draw([]); assert.equal(panel.innerHTML,'Assigned team vs opponent');
});

// admin.html: a refresh right after a tournament save/delete can read the previous season copy
// (Blobs reads are eventually consistent) — the page must keep the newer copy the write returned.
const adminSource = fs.readFileSync(new URL('../admin.html',import.meta.url),'utf8');
function adminClient(name, globals={}) {
  const start=adminSource.indexOf(`function ${name}(`);
  assert.ok(start>=0, name);
  const tail=adminSource.slice(start), end=tail.search(/^}/m)+1;
  return vm.runInNewContext(`(${tail.slice(0,end)})`,globals);
}
test('admin keeps the season a save/delete returned over an older read, then yields to newer reads',()=>{
  const globals={ FRESH_SEASON:{ teamKey:'t', key:'s', updatedAt:'2026-09-15T10:00:01Z', seasonData:[{key:'new'}] },
    STATE:{ season:{ teamKey:'t', key:'s', updatedAt:'2026-09-15T10:00:00Z', seasonData:[] }, config:{ seasonData:[] } } };
  const prefer=adminClient('preferFreshSeason', globals);
  prefer();
  assert.deepEqual(globals.STATE.season.seasonData, [{key:'new'}]);
  assert.deepEqual(globals.STATE.config.seasonData, [{key:'new'}]);

  globals.STATE={ season:{ teamKey:'t', key:'s', updatedAt:'2026-09-15T10:00:02Z', seasonData:[{key:'newer'}] }, config:{} };
  prefer();
  assert.deepEqual(globals.STATE.season.seasonData, [{key:'newer'}]);
  assert.equal(globals.FRESH_SEASON, null);
});

// admin.html Games card: no list until a search or Show all, and an empty state that says why.
test('admin Games card waits for a search or Show all and explains each empty state',()=>{
  const el={ gameFilter:{ value:'' }, gamesShowAll:{ textContent:'', disabled:false }, games:{ innerHTML:'' }, gamesCollapsedSummary:{ textContent:'' } };
  const game={ key:'g1', top:'Wicked Elite', bot:'Example Queens', where:'Pool A', time:'2026-10-17T13:20:00' };
  const globals={ $:sel=>el[sel.slice(1)], GAMES:[], GAMES_SHOW_ALL:false, CTX:{ eventKey:'foo' },
    SNAP:{ meta:{}, results:{} }, overrides:()=>({}), streamLinks:()=>({}), fmtTime:()=>'Sat 1:20 PM',
    esc:v=>String(v).replaceAll('<','&lt;') };
  const render=adminClient('renderGames', globals);
  const shown=()=>{ render(); return el.games.innerHTML; };

  globals.CTX={ eventKey:null };
  assert.match(shown(), /no tournament is set active/);
  assert.equal(el.gamesCollapsedSummary.textContent, '0 games');
  globals.CTX={ eventKey:'foo' }; globals.SNAP=null;
  assert.match(shown(), /Couldn’t load/);
  globals.SNAP={ meta:{ schedulePending:true }, results:{} };
  assert.match(shown(), /hasn’t published/);
  globals.SNAP={ meta:{}, results:{} };
  assert.match(shown(), /hasn’t been loaded/);
  assert.equal(el.gamesShowAll.disabled, true);

  globals.GAMES=[game];
  assert.match(shown(), /show all 1 game\./);
  assert.equal(el.gamesCollapsedSummary.textContent, '1 game');
  assert.doesNotMatch(el.games.innerHTML, /class="game"/);
  el.gameFilter.value='queens';
  assert.match(shown(), /class="game"/);
  el.gameFilter.value='<zzz';
  assert.match(shown(), /No games match “&lt;zzz”/);
  el.gameFilter.value=''; globals.GAMES_SHOW_ALL=true;
  assert.match(shown(), /class="game"/);
  assert.equal(el.gamesShowAll.textContent, 'Hide all');
  // Show all / Hide all replace the search, so the click always changes the list.
  assert.match(adminSource, /GAMES_SHOW_ALL = !GAMES_SHOW_ALL;\s*\$\('#gameFilter'\)\.value = '';/);
});

// admin.html: the auto-unlock on load runs with an empty secret field — it must use the stored
// secret, not overwrite it with the empty field (which locked the page again on every reload).
test('admin auto-unlock keeps the stored secret; only a typed secret replaces it',async()=>{
  const start=adminSource.indexOf('async function unlock(');
  assert.ok(start>=0);
  const body=adminSource.slice(start), source=body.slice(0, body.search(/^}/m)+1);
  const stored=new Map([['wickedAdminKey','saved-secret']]);
  const usedSecrets=[], classes=()=>({classList:{add(){},remove(){}}});
  const globals={ KEYK:'wickedAdminKey', toast(){},
    localStorage:{ getItem:key=>stored.get(key) ?? null, setItem:(key,value)=>stored.set(key,value) },
    $:selector=>selector==='#secret' ? { value:'' } : classes(),
    loadAll:async()=>{ usedSecrets.push(stored.get('wickedAdminKey')); } };
  const unlock=vm.runInNewContext(`(${source})`,globals);
  await unlock();
  assert.equal(stored.get('wickedAdminKey'),'saved-secret');
  await unlock('  typed-secret ');
  assert.equal(stored.get('wickedAdminKey'),'typed-secret');
  assert.deepEqual(usedSecrets,['saved-secret','typed-secret']);

  // The wiring: load calls unlock() with nothing; the button and Enter pass the typed value, never
  // the click event.
  const wiringStart=adminSource.indexOf('const unlockTyped');
  const wiringEnd=adminSource.indexOf('if (adminKey()) unlock();',wiringStart);
  assert.ok(wiringStart>=0 && wiringEnd>wiringStart);
  const calls=[], button={}, field={ value:'typed', addEventListener(_type,handler){ this.keydown=handler; } };
  vm.runInNewContext(adminSource.slice(wiringStart,wiringEnd)+'if (adminKey()) unlock();',{
    $:selector=>selector==='#secret' ? field : button, adminKey:()=>'saved-secret', unlock:(...args)=>calls.push(args) });
  assert.deepEqual(calls,[[]]);
  button.onclick({type:'click'});
  field.keydown({key:'a'});
  field.keydown({key:'Enter'});
  assert.deepEqual(calls,[[],['typed'],['typed']]);
});

test('coming-soon roster entries split "Team-Coach" and keep names without a coach intact',()=>{
  const split=client('splitRosterName');
  assert.deepEqual({...split('Example Valley Club-Coach One')},{team:'Example Valley Club',coach:'Coach One'});
  assert.deepEqual({...split('LTG-Matheny/Palacios')},{team:'LTG',coach:'Matheny/Palacios'});
  assert.deepEqual({...split('Example West Club - 10U (Coach Two)')},{team:'Example West Club - 10U',coach:'Coach Two'});
  assert.deepEqual({...split('Bay Area Blaze 10U')},{team:'Bay Area Blaze 10U',coach:''});
  const display=client('displayTeamName',{splitRosterName:split,historyEsc:value=>String(value),
    TEAM_DISPLAY:{ opp:{ name:'Storm' } }});
  assert.equal(display('Wicked Elite - Agar'),'Wicked Elite');
  assert.equal(display('Delta Storm - Alvarez','opp'),'Storm');
  assert.equal(display('Delta Storm - Alvarez','other'),'Delta Storm');
});

test('pending-schedule standings show 0–0 and list Wicked first among registered teams',()=>{
  const render=client('comingSoonTeamsHtml',{
    splitRosterName:client('splitRosterName'), comingSoonTown:()=>'',
    registeredTeamIsOurs:client('registeredTeamIsOurs',{splitRosterName:client('splitRosterName')}),
    historyEsc:value=>String(value), MY_ID:'wicked', TEAM_DISPLAY:{},
    gameChangerLocationHtml:id=>id==='wicked' ? '<span class="team-location">Agar · Example City, CA</span>'
      : id==='name:exampleoutlawsavina' ? '<span class="team-location">Avina · Example, CA</span>' : '',
    gameChangerRecordHtml:id=>id==='wicked' ? '8–2' : id==='name:exampleoutlawsavina' ? '<a href="/gc">5–1</a>' : '—'
  });
  const html=render({ast:{teamName:'Wicked Elite-Agar',teams:[
    'Example Outlaws-Avina','Wicked Elite-Agar','Example Banshees-Rivas'
  ]}}, {name:'Wicked Elite'});
  assert.match(html, /<li class="cs-team is-us"><span class="cs-team-num">1<\/span>/);
  assert.doesNotMatch(html, /Our team|cs-us/);
  assert.ok(html.indexOf('Wicked Elite') < html.indexOf('Example Outlaws'));
  assert.equal((html.match(/<span class="cs-team-wl">0–0<\/span>/g) || []).length, 3);
  assert.match(html, /Wicked Elite[\s\S]*?<span class="cs-team-record">8–2<\/span>/);
  assert.match(html, /Example Outlaws[\s\S]*?<span class="cs-team-record"><a href="\/gc">5–1<\/a><\/span>/);
  assert.match(html, /Example Outlaws[\s\S]*?<span class="team-location">Avina · Example, CA<\/span>/);
  assert.doesNotMatch(html, /Coach Avina/);
  assert.match(html, /<div class="cs-column-headings">/);
  assert.equal((html.match(/<div class="cs-column-heading"><span>Team<\/span><span class="cs-wl-heading" title="Tournament record">W–L<\/span><img src="\/assets\/gamechanger-logo\.png" alt="GameChanger record" title="GameChanger season record"><\/div>/g) || []).length, 2);
  assert.match(html, /Example Banshees[\s\S]*?<span class="cs-team-record">—<\/span>/);
  assert.doesNotMatch(html, /gc-team-link/);
});

test('pending standings show the tournament record when no roster is published',()=>{
  const nodes={sbPendingNote:{},standingsPendingNote:{}};
  const render=client('renderPendingSchedule',{
    document:{getElementById:id=>nodes[id]}, formatTourneyDates:()=>'', historyEsc:value=>String(value)
  });
  render({meta:{schedulePending:true}});
  assert.match(nodes.standingsPendingNote.innerHTML,/Tournament record: 0–0/);
});

test('registered-team popup uses our team ID for Wicked GameChanger link',()=>{
  const subtitleClasses=new Set();
  const nodes={
    modalTitle:{},modalBody:{},modalLocation:{},modalPool:{textContent:'Pool B',hidden:false},
    modalSubtitle:{classList:{toggle(name,on){if(on) subtitleClasses.add(name); else subtitleClasses.delete(name);}}},
    teamModal:{classList:{add(){}}}
  };
  const splitRosterName=client('splitRosterName');
  const globals={
    PENDING_AST_META:{division:'10U',ast:{region:'South Bay',teamName:'Wicked Elite-Agar',teams:['Wicked Elite-Agar','Example Outlaws-Avina']}},
    MY_ID:'example-team', MY_NAME:'Wicked Elite', AST_TEAM_NAME:'Wicked Elite-Agar', splitRosterName,
    GAMECHANGER_TEAMS:{
      'example-team':'https://web.gc.com/teams/wicked-gc/roster',
      'name:exampleoutlawsavina':'https://web.gc.com/teams/benicia-gc/roster'
    },
    GAMECHANGER_LOCATIONS:{'example-team':{city:'Example City',state:'CA'}}, TEAM_DISPLAY:{},
    registeredTeamIsOurs:client('registeredTeamIsOurs',{splitRosterName}),
    historyEsc:value=>String(value), document:{getElementById:id=>nodes[id]}
  };
  globals.gameChangerAppUrl=client('gameChangerAppUrl');
  globals.gameChangerLocationHtml=client('gameChangerLocationHtml',globals);
  globals.setTeamModalHeader=client('setTeamModalHeader',globals);
  globals.teamModalLinksHtml=client('teamModalLinksHtml',globals);
  const show=client('showRegisteredTeam',globals);
  show('Wicked Elite-Agar');
  assert.equal(nodes.modalTitle.textContent,'Wicked Elite');
  assert.match(nodes.modalBody.innerHTML, /href="https:\/\/web\.gc\.com\/teams\/wicked-gc\/team"/);
  assert.match(nodes.modalBody.innerHTML, /class="team-modal-links"/);
  assert.match(nodes.modalBody.innerHTML, /<span class="team-modal-link-label">GameChanger<\/span>/);
  assert.doesNotMatch(nodes.modalBody.innerHTML, /gc-team-link|gamechanger-logo/);
  assert.match(nodes.modalBody.innerHTML, /Tournament division: 10U/);
  assert.match(nodes.modalLocation.innerHTML, /Agar · Example City, CA/);
  assert.equal(nodes.modalLocation.hidden,false);
  assert.equal(nodes.modalSubtitle.hidden,false);
  assert.ok(subtitleClasses.has('has-location'));
  assert.equal(nodes.modalPool.textContent,'');
  assert.equal(nodes.modalPool.hidden,true);
  assert.doesNotMatch(nodes.modalBody.innerHTML, /Example City, CA/);
  assert.doesNotMatch(nodes.modalBody.innerHTML, /South Bay/);
  show('Example Outlaws-Avina');
  assert.equal(nodes.modalTitle.textContent,'Example Outlaws');
  assert.match(nodes.modalBody.innerHTML, /href="https:\/\/web\.gc\.com\/teams\/benicia-gc\/team"/);
  assert.match(nodes.modalLocation.innerHTML, /Avina/);
  assert.doesNotMatch(nodes.modalLocation.innerHTML, /Agar|Example City/);
});

test('coming-soon location is the AST town, read from the age heading when the structure predates ast.location',()=>{
  const astHeadingTown=client('astHeadingTown');
  const comingSoonTown=client('comingSoonTown',{astHeadingTown});
  const comingSoonPlace=client('comingSoonPlace',{comingSoonTown});
  const legacy={ast:{region:'South Bay',divisionLabel:'10U-Livermore-(Teams must pre pay their gate fee of $125)'},venue:{city:'South Bay'}};
  assert.equal(comingSoonPlace(legacy),'Livermore');
  assert.equal(comingSoonPlace({ast:{region:'South Bay',location:'Hayward',divisionLabel:'10U'},venue:{city:'Hayward'}}),'Hayward');
  assert.equal(comingSoonPlace({ast:{region:'Reno',divisionLabel:'10U'},venue:{city:'Reno'}}),'Reno');   // no town published
  assert.equal(comingSoonPlace({venue:{city:'Manteca, CA'}}),'Manteca, CA');                           // non-AST
  assert.equal(astHeadingTown('12U-switched location to Hayward'),'Hayward');
});

test('team links never borrow the default team: snacks only for a configured URL, rank card needs NorCal count',()=>{
  const src = source;
  // No hardcoded snacks sheet in the markup; the link starts hidden.
  assert.match(src, /<a id="snacksLink" href="#"[^>]*hidden>/);
  // initTournamentUI must not re-point the rank/logo links at the default team's NorCal id.
  const init = src.slice(src.indexOf('function initTournamentUI('), src.indexOf('function initTournamentUI(') + 1200);
  assert.doesNotMatch(init, /\$\{NORCAL_TEAM_ID\}/);
  const render = (w, cached=null) => {
    const els={};
    const el=id=>els[id]??={};
    client('applyWickedStats',{ localStorage:{ getItem:()=>cached && JSON.stringify(cached), setItem(){} }, TEAM_STATS_KEY:'k', SEASON_OVER:false,
      setRankFireworks(){}, buildRecentResults(){}, applySeasonCompleteUI(){},
      document:{ getElementById:el } })(w);
    return els;
  };
  // A team with no games yet: 0–0, and no rank card at all.
  const fresh = render(null);
  assert.equal(fresh.statSeason.textContent, '0–0');
  assert.equal(fresh.statNorcalLink.hidden, true);
  assert.equal(render({ season:'0-0', rank:null, rankOf:null }).statNorcalLink.hidden, true);
  assert.equal(render({ season:'22-8', rank:3, rankOf:null }).statNorcalLink.hidden, true);
  assert.equal(render({ season:'22-8', rank:3, rankOf:0 }).statNorcalLink.hidden, true);
  assert.equal(render({ rank:3, rankOf:null }, { season:'22-8', rank:3, rankOf:95 }).statNorcalLink.hidden, true);
  // A ranked team keeps the card, with its own count.
  const ranked = render({ season:'22-8-1', rank:3, rankOf:95 });
  assert.equal(ranked.statSeason.textContent, '22–8–1');
  assert.equal(ranked.statNorcal.textContent, '#3');
  assert.equal(ranked.statNorcalLink.hidden, false);
  assert.equal(ranked.statNorcalLbl.innerHTML, 'CA-NorCal<br>of 95');
});

test('an out-of-range forecast hides the weather row and clears the fetch key so a later tick retries',async()=>{
  const els={};
  const globals={
    TOURNAMENT:{ venue:{ lat:37.7, lon:-121.9 } },
    fetch:async()=>({ json:async()=>({ daily:{ time:['2026-09-15','2026-09-16','2026-09-17','2026-09-18'] }, hourly:{ time:['2026-09-18T23:00'] } }) }),
    AbortSignal:{ timeout:()=>undefined },
    document:{ getElementById:id=>els[id]??={} },
    window:{ _wxKey:'day:2026-09-19' },
    console:{ error(){} },
  };
  // fetchWeather is async — extract it with its keyword (client() slices from `function name(`).
  const start=source.indexOf('async function fetchWeather(');
  const tail=source.slice(start), end=tail.search(/^}/m)+1;
  const fetchWeather=vm.runInNewContext(`(${tail.slice(0,end)})`,globals);
  await fetchWeather({ day:'2026-09-19' });
  assert.equal(els.wxRow.hidden, true);
  assert.equal(globals.window._wxKey, null);
});

// Upcoming Games pager.
const historyEsc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('a game stays on the Upcoming Games card until 30 minutes after its start',()=>{
  const upcoming=client('upcomingMyGames');
  const games=[{key:'early',t:'2026-10-17T20:20:00Z'},{key:'late',t:'2026-10-17T21:40:00Z'}];
  const keys=now=>upcoming(games,new Date(now)).map(g=>g.key);
  assert.deepEqual(keys('2026-10-17T20:30:00Z'),['early','late']);   // 10 minutes in: still shown
  assert.deepEqual(keys('2026-10-17T20:50:00Z'),['late']);           // 30 minutes in: moves on
  assert.deepEqual(keys('2026-10-17T22:15:00Z'),[]);
});
// What the Upcoming Games page builders need, with the shared shell and scouting links wired in.
function upcomingPageGlobals(TOURNAMENT,SCOUT_SUMMARIES){
  const g={MY_ID:'us',MY_NAME:'Wicked Elite',historyEsc,TOURNAMENT,NXT_RECORD_HEADING:'<div class="heading"><span></span><span>W–L</span></div>',
    nextTeamRowHtml:(id,name,_r,proj)=>`<row ${id}${proj?' proj':''}>${name}</row>`,nextVenue:client('nextVenue',{TOURNAMENT}),
    scoutStripInner:client('scoutStripInner',{historyEsc}),SCOUT_SUMMARIES};
  g.scoutStrips=client('scoutStrips',g);
  g.upcomingPageHtml=client('upcomingPageHtml',g);
  return g;
}
test('once the bracket is set, later pages follow our winning path with its possible opponents',()=>{
  // The live Gold bracket: we play G4 (vs Winner of G2), then G5 (vs Winner of G3) if we win.
  const TOURNAMENT={venue:{city:'San Bruno, CA',name:'Parkside Middle School'},bracketDate:'2026-10-18'};
  const frame=[
    {gameNo:1,topSeed:4,topId:'wv',topName:'West Valley',botSeed:5,botId:'cv',botName:'Example Valley'},
    {gameNo:2,topSeed:3,topId:'red',topName:'Burlingame Red',botSeed:6,botId:'rp',botName:'Rohnert Park'},
    {gameNo:3,topSeed:1,topId:'sc',topName:'San Carlos',botGame:1},
    {gameNo:4,key:'k4',time:'2026-10-18T13:15:00',topGame:2,botSeed:2,botId:'us',botName:'Wicked Elite'},
    {gameNo:5,key:'k5',time:'2026-10-18T14:40:00',fac:'Parkside Middle School',field:'South',topGame:3,botGame:4},
  ];
  const g=upcomingPageGlobals(TOURNAMENT,[{id:'sc',name:'San Carlos'},{id:'cv',name:'Example Valley'},{id:'red',name:'Burlingame Red'}]);
  Object.assign(g,{BRACKETS:[{level:'gold',frame}],bracketGameData:{gold:[{gameNo:5,field:'North',topId:null}]},BRACKET_SEEDED:{},
    BRACKET_TIMES:{},BRACKET_LABELS:{gold:'10U - Gold Bracket'},BRACKET_DATE_LABEL:'Sun, Oct 18',bracketResultOf:()=>null});
  g.projectBracketSlot=client('projectBracketSlot',g);
  g.bracketSlotCandidates=client('bracketSlotCandidates',g);
  g.bracketScoutTargets=client('bracketScoutTargets',g);
  g.bracketOppRowHtml=client('bracketOppRowHtml',g);
  g.bracketGameWithFrame=client('bracketGameWithFrame');
  const path=client('bracketWinningPath',g)('gold',4);
  assert.deepEqual([...path.map(p=>[p.game.gameNo,p.wickedIsTop])].map(a=>[...a]),[[5,false]]);
  assert.equal(path[0].game.field,'North');        // live data wins over the frame
  assert.equal(path[0].game.topGame,3);            // but a null live value keeps the frame's
  assert.equal(client('bracketWinningPath',g)('gold',5).length,0);   // the final ends the path
  assert.equal(client('bracketWinningPath',g)('gold',-4).length,0);  // losers-bracket games have none
  const page=client('bracketUpcomingPage',g)('gold',path[0].game,false);
  assert.equal(page.key,'k5');
  assert.equal(page.meta,'Sun, Oct 18  ·  2:40 PM  ·  10U - Gold Bracket');
  assert.equal(page.wx,'2026-10-18T14:40:00');
  assert.match(page.html,/<row null>Winner of G3<\/row>/);
  assert.ok(page.html.indexOf('Winner of G3')<page.html.indexOf('<row us>'));   // no seeds: we're listed home
  assert.match(page.html,/Parkside Middle School · North/);
  // We only play G5 if we win G4; the record heading says so.
  assert.match(page.html,/<div class="heading"><span><span class="nxt-cond">If we win G4<\/span><\/span><span>W–L<\/span><\/div>/);
  // Every team that can still reach G3's winner slot, if it has a report.
  assert.deepEqual([...page.html.matchAll(/data-scout-open="([^"]+)"/g)].map(m=>m[1]),['sc','cv']);
  // Two or more reports: a "Scouting reports" label over wrapping pills, the note only in the labels.
  assert.match(page.html,/<div class="scout-pills-label">.*Scouting reports<\/div>/);
  assert.equal([...page.html.matchAll(/class="scout-pill"/g)].length,2);
  assert.doesNotMatch(page.html,/class="scout-strip"/);
  assert.match(page.html,/aria-label="Open the scouting report for San Carlos \(Possible opponent · Winner of G3\)"/);
  assert.doesNotMatch(page.html.replace(/aria-label="[^"]*"/g,''),/Winner of G3<\/span>|Possible opponent/);
});
test('the next live bracket game takes its opponent feed from the frame, so its possible opponents are scouted',()=>{
  // NorCal's live G4 has our team but no feeds; the frame says the other side is the Winner of G2.
  const frame=[
    {gameNo:2,topSeed:3,topId:'red',topName:'Burlingame Red',botSeed:6,botId:'rp',botName:'Rohnert Park'},
    {gameNo:4,topGame:2,botSeed:2,botId:'us',botName:'Wicked Elite'},
  ];
  const live={gameNo:4,key:'k4',time:'2026-10-18T13:15:00',topSeed:null,topId:null,topName:null,botSeed:'2',botId:'us',status:null};
  const game=client('bracketGameWithFrame')(frame[1],live);
  assert.equal(game.topGame,2);
  assert.equal(game.key,'k4');
  const g={MY_ID:'us',BRACKETS:[{level:'gold',frame}],bracketGameData:{gold:[live]},BRACKET_SEEDED:{},bracketResultOf:()=>null};
  g.projectBracketSlot=client('projectBracketSlot',g);
  g.bracketSlotCandidates=client('bracketSlotCandidates',g);
  const targets=client('bracketScoutTargets')(g.bracketSlotCandidates('gold',null,null,null,game.topGame),g.projectBracketSlot('gold',null,game.topGame).label);
  assert.deepEqual([...targets].map(t=>[t.id,t.note]),[['red','Possible opponent · Winner of G2'],['rp','Possible opponent · Winner of G2']]);
});
test('a single scouting report keeps the full-width strip with its note',()=>{
  const strips=client('scoutStrips',{SCOUT_SUMMARIES:[{id:'red',name:'Burlingame Red'}],historyEsc,scoutStripInner:client('scoutStripInner',{historyEsc})});
  const one=strips([{id:'red',note:'Possible opponent · Winner of G2'},{id:'rp',note:'Possible opponent · Winner of G2'}]);
  assert.match(one.html,/^<button type="button" class="scout-strip" data-scout-open="red"/);
  assert.match(one.html,/<span>Possible opponent · Winner of G2<\/span>/);
  assert.equal(one.key,'red:Possible opponent · Winner of G2');
  assert.deepEqual({...strips([{id:'rp'}])},{key:'',html:''});
});
test('later Upcoming Games pages list the visitor first and link scouting only when a report exists',()=>{
  const TOURNAMENT={venue:{city:'San Bruno, CA',name:'Parkside Middle School',mapsUrl:'https://maps.example/park'}};
  const page=client('upcomingPage',upcomingPageGlobals(TOURNAMENT,[{id:'cv',name:'Example Valley Club'}]));
  const home=page({key:'g2',t:'2026-10-17T14:40:00',hid:'us',aid:'cv',hn:'Wicked Elite',an:'Example Valley Club',facName:'San Bruno City Park',field:'D2'});
  assert.equal(home.meta,'Sat, Oct 17  ·  2:40 PM');
  assert.equal(home.wx,'2026-10-17T14:40:00');
  assert.ok(home.html.indexOf('<row cv>')<home.html.indexOf('<row us>'));   // we're home: listed second
  assert.match(home.html,/data-game="g2"/);
  assert.match(home.html,/San Bruno City Park · D2/);
  assert.match(home.html,/data-scout-open="cv"/);
  const away=page({key:'g3',t:'2026-10-17T17:20:00',hid:'sb',aid:'us',hn:'Example Select B',an:'Wicked Elite'});
  assert.ok(away.html.indexOf('<row us>')<away.html.indexOf('<row sb>'));   // we're away: listed first
  assert.match(away.html,/Parkside Middle School/);                          // no facility: tournament venue
  assert.doesNotMatch(away.html,/data-scout-open/);
  assert.doesNotMatch(home.html+away.html,/nxt-cond/);   // pool games don't depend on a result
});
test('a later page with no forecast yet is marked for retry without resetting page 1',async()=>{
  const slot={row:{dataset:{}},icon:{},temp:{},wind:{}};
  const globals={
    TOURNAMENT:{venue:{lat:37.7,lon:-122.4}},
    fetch:async()=>({json:async()=>({daily:{time:['2026-10-15']},hourly:{time:['2026-10-21T23:00']}})}),
    AbortSignal:{timeout:()=>undefined},
    document:{getElementById:()=>({})},
    window:{_wxKey:'2026-10-17T13:20:00'},
    console:{error(){}},
  };
  const start=source.indexOf('async function fetchWeather(');
  const tail=source.slice(start), end=tail.search(/^}/m)+1;
  const fetchWeather=vm.runInNewContext(`(${tail.slice(0,end)})`,globals);
  await fetchWeather('2026-10-30T13:20:00',slot);
  assert.equal(slot.row.hidden,true);
  assert.equal(slot.row.dataset.wxRetry,'1');
  assert.equal(globals.window._wxKey,'2026-10-17T13:20:00');   // page 1's own retry key untouched
});
