/* Scouting report modal, shared by index.html and admin.html; styles in scouting-report.css.
   A classic script (no module) loaded at the end of <body>: it injects the modal markup, and its
   top-level names are globals both pages use — openScoutingReport/closeScoutingReport, plus
   SCOUT_REPORT and scoutDate on the admin page. Admin-only controls render when that page defines
   editScoutingCompetition. */
// Escapes text for safe insertion into HTML.
const scoutEsc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Formats a timestamp as a Pacific date and time, e.g. "Oct 13, 3:15 PM PT".
const scoutDate=value=>value?new Date(value).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' PT':'—';
// Formats a count or average to fixed decimals, or a dash when the stat is missing.
const scoutNumber=(value,digits=0)=>value==null?'—':Number(value).toFixed(digits);
// Formats a 0–1 rate as a whole percent, or a dash when missing.
const scoutRate=value=>value==null?'—':Math.round(value*100)+'%';
// Formats a batting average baseball-style (.429), or a dash when missing.
const scoutAvg=value=>value==null?'—':Number(value).toFixed(3).replace(/^0/,'');
// Converts recorded outs to innings pitched notation (17.1 = 17 innings and one out).
const scoutIp=outs=>outs==null?'—':Math.floor(outs/3)+'.'+outs%3;
// Formats a timestamp as a short Pacific date, e.g. "Oct 11".
const scoutDay=value=>value?new Date(value).toLocaleDateString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric'}):'—';
// Returns W, L or T from runs scored and allowed.
const scoutResult=(rf,ra)=>rf>ra?'W':rf<ra?'L':'T';
const SCOUT_TABS=['Overview','Hitters','Pitchers','Games'];
const SCOUT_GROUPS=[['All','All'],['B','B teams'],['C','C teams']];
const SCOUT_BASIS={'NorCal classification':'NorCal class','Provider classification':'Tournament class','Provider registration':'Registered class','Coach classification':'admin verified','Likely C':'C - performance based','Likely B':'B - performance based','B by default':'B - default, insufficient data'};
// Display faces load on first open, so the dashboard itself never pays for them.
const SCOUT_FONTS='https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Caveat:wght@700&family=JetBrains+Mono:wght@500;700&display=swap';
let SCOUT_REPORT=null,SCOUT_TAB='Overview',SCOUT_GROUP='All',SCOUT_REQUEST=0,SCOUT_FOCUS=null,SCOUT_INERT=[];

document.body.insertAdjacentHTML('beforeend','<div id="scoutModal" class="scout-overlay" hidden><section class="sr-dialog" role="dialog" aria-modal="true" aria-labelledby="scoutKicker scoutTitle"><div class="sr-scroll" id="scoutScroll"><div class="sr-card" id="scoutView" aria-live="polite"></div></div></section></div>');

// Builds the card header: kicker line with the close button, team name (with an optional
// right-aligned badge, e.g. the star rating), subtitle, and any extra rows.
function scoutHeader(kicker,title,sub,extra='',badge=''){
  // A div, not <header>: admin.html styles bare header elements as its sticky page bar.
  return '<div class="sr-head"><div class="sr-kick"><span id="scoutKicker">'+scoutEsc(kicker)+'</span><button class="sr-x" id="scoutClose" type="button" aria-label="Close scouting report"><span aria-hidden="true">✕</span></button></div>'
    +'<div class="sr-title-row"><h2 class="sr-title" id="scoutTitle">'+scoutEsc(title)+'</h2>'+badge+'</div>'+(sub?'<p class="sr-sub">'+scoutEsc(sub)+'</p>':'')+extra+'</div>';
}
// Shows a header plus a single status line (loading or an error) in place of a report.
function scoutMessage(html,title='Scouting report'){
  document.getElementById('scoutView').innerHTML=scoutHeader('Scouting report',title,'')+'<div class="sr-body"><p class="sr-msg">'+html+'</p></div>';
}
// Loading screen while a report is fetched: the opponent's name when known, a spinning softball,
// and placeholder bars in the shape of the record line and the first rows.
function scoutLoading(name){
  const bar=(width,cls='')=>'<span class="sr-skel'+cls+'" style="width:'+width+'"></span>';
  const line='<div class="sr-skel-sub" aria-hidden="true">'+bar('46%')+'</div><div class="sr-line sr-skel-line" aria-hidden="true">'+[0,1,2].map(()=>'<div>'+bar('46px',' tall')+bar('58px')+'</div>').join('')+'</div>';
  const ball='<svg class="sr-ball" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="rgb(250 204 21)" stroke="var(--sr-ink)" stroke-width="2"/><path d="M10 7c5 7 5 19 0 26M30 7c-5 7-5 19 0 26" fill="none" stroke="var(--sr-pen)" stroke-width="2" stroke-dasharray="2.5 2.5"/></svg>';
  document.getElementById('scoutView').innerHTML=scoutHeader('Scouting report',name||'Scouting report','',line)
    +'<div class="sr-body"><div class="sr-loading" role="status">'+ball+'<span>Loading scouting report…</span></div>'
    +'<div class="sr-skel-rows" aria-hidden="true">'+['92%','78%','85%','64%'].map(width=>'<div>'+bar(width)+'</div>').join('')+'</div></div>';
}
// Hides the modal, restores the page behind it, and returns focus to the control that opened it.
function closeScoutingReport(){
  SCOUT_REQUEST++;document.getElementById('scoutModal').hidden=true;
  for(const [node,inert] of SCOUT_INERT)node.inert=inert;
  SCOUT_INERT=[];document.body.classList.remove('scout-open');document.body.style.overflow='';SCOUT_FOCUS?.focus();SCOUT_REPORT=null;
}
// Opens the modal for one opponent, locks the page behind it, and loads the saved report.
// `name` (optional) labels the loading screen until the report arrives.
async function openScoutingReport(id,query,name=''){
  const request=++SCOUT_REQUEST;SCOUT_FOCUS=document.activeElement;SCOUT_TAB='Overview';SCOUT_GROUP='All';SCOUT_REPORT=null;
  if(!document.getElementById('scoutFonts'))document.head.insertAdjacentHTML('beforeend','<link id="scoutFonts" rel="stylesheet" href="'+SCOUT_FONTS+'">');
  const modal=document.getElementById('scoutModal');modal.hidden=false;
  SCOUT_INERT=[...document.body.children].filter(n=>n!==modal&&!['SCRIPT','STYLE'].includes(n.tagName)).map(n=>[n,n.inert]);
  for(const [node] of SCOUT_INERT)node.inert=true;
  document.body.classList.add('scout-open');document.body.style.overflow='hidden';
  scoutLoading(name);document.getElementById('scoutScroll').scrollTop=0;document.getElementById('scoutClose').focus();
  try{
    const response=await fetch('/api/scouting-report?'+query+'&opponent='+encodeURIComponent(id),{cache:'no-store'});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Could not load scouting report.');
    if(request!==SCOUT_REQUEST)return;
    SCOUT_REPORT=data.report;renderScoutingReport();document.getElementById('scoutClose').focus();
  }catch(error){if(request===SCOUT_REQUEST){scoutMessage('<span class="sr-error">'+scoutEsc(error.message)+'</span>',name||undefined);document.getElementById('scoutClose').focus();}}
}

// Wraps content in a titled report section with an optional right-aligned note.
const scoutSection=(title,meta,inner)=>'<section class="sr-sec"><h3>'+title+(meta?'<span>'+meta+'</span>':'')+'</h3>'+inner+'</section>';
// Renders highlight badges (e.g. "Hitting .400+") as handwritten pen notes.
const scoutFlags=badges=>(badges||[]).map(b=>'<span class="sr-flag">'+scoutEsc(b)+'</span>').join('');
// Formats a player's jersey number and name, e.g. "#7 Maya Lindqvist".
const scoutPlayerName=p=>(p.number?'#'+scoutEsc(p.number)+' ':'')+scoutEsc(p.name);
// Pairs a count with a singular or plural word, e.g. "1 game" / "8 games".
const scoutPlural=(n,word)=>n+' '+word+(n===1?'':'s');

// The 1–4 star rating as Font Awesome stars (half stars allowed); the reasons are its tooltip.
function scoutStars(rating){
  if(!rating)return '';
  const icons=[1,2,3,4].map(i=>rating.stars>=i?'fa-solid fa-star':rating.stars>=i-.5?'fa-solid fa-star-half-stroke':'fa-regular fa-star');
  const label=rating.stars+' of 4 stars';
  return '<span class="sr-stars" role="img" aria-label="Rated '+label+'" title="'+scoutEsc(label+': '+rating.reasons.join('; '))+'">'+icons.map(c=>'<i class="'+c+'" aria-hidden="true"></i>').join('')+'</span>';
}
// Overview tab: the team summary, recent games, players to watch, runs by inning, scoring
// tendencies, and what the star rating is based on.
function scoutOverview(view,summary,stars){
  const games=view.games||[],t=view.tendencies,s=view.season;
  let html=(summary?'<p class="sr-summary">'+scoutEsc(summary)+'</p>':'')+scoutSection('Recent games','newest first',games.length
    ?'<div class="sr-form">'+games.map(g=>{const r=scoutResult(g.rf,g.ra);const label=scoutDay(g.date)+' vs '+g.opponent;return '<button type="button" class="'+r+'" data-scout-game="'+scoutEsc(g.id)+'" title="'+scoutEsc(label)+'" aria-label="'+scoutEsc(label+', '+r+' '+g.rf+'-'+g.ra+'. Show on the Games tab')+'"><b>'+r+'</b><span>'+g.rf+'-'+g.ra+'</span></button>';}).join('')+'</div>'
    :'<p class="sr-msg">No completed games against this class since September 1.</p>');
  const hitters=view.hitters.filter(p=>p.badges.length),pitchers=view.pitchers.filter(p=>p.badges.length);
  html+=scoutSection('Players to watch','',(hitters.length||pitchers.length)
    ?hitters.map(p=>'<div class="sr-w"><div class="sr-no">'+scoutEsc(p.number||'–')+'</div><div class="sr-who"><b>'+scoutEsc(p.name)+'</b><span>'+scoutNumber(p.counts.H)+'-for-'+scoutNumber(p.counts.AB)+' · '+scoutNumber(p.counts.BB)+' BB · '+scoutNumber(p.counts.SO)+' K</span><div>'+scoutFlags(p.badges)+'</div></div><div class="sr-big">'+(p.badges.includes('Hitting .400+')?'<b>'+scoutAvg(p.metrics.avg)+'</b><span>AVG</span>':'')+(p.badges.includes('Extra-base production')?'<b>'+scoutNumber(p.metrics.xbh)+'</b><span>XBH</span>':'')+'</div></div>').join('')
      +pitchers.map(p=>'<div class="sr-w"><div class="sr-no">'+scoutEsc(p.number||'–')+'</div><div class="sr-who"><b>'+scoutEsc(p.name)+' · P</b><span>'+scoutIp(p.metrics.outs)+' IP · '+scoutNumber(p.counts.SO)+' K · '+scoutNumber(p.counts.BB)+' BB</span><div>'+scoutFlags(p.badges)+'</div></div><div class="sr-big">'+[['Strikeout leader','kRate','K rate'],['Low walk rate','bbRate','BB rate']].filter(([badge])=>p.badges.includes(badge)).map(([,key,label])=>'<b>'+scoutRate(p.metrics[key])+'</b><span>'+label+'</span>').join('')+'</div></div>').join('')
    :'<p class="sr-msg">No hitter or pitcher meets the highlight thresholds yet.</p>');
  // Average runs per inning across every game with a recorded line score.
  const lines=games.filter(g=>g.innings?.length),length=Math.max(0,...lines.map(g=>g.innings.length));
  if(lines.length){
    const avgs=Array.from({length},(_,i)=>{const runs=lines.filter(g=>g.innings.length>i).map(g=>g.innings[i]);return runs.reduce((a,b)=>a+b,0)/runs.length;});
    const peak=Math.max(.1,...avgs);
    html+=scoutSection('Runs by inning','average per game','<div class="sr-inn">'+avgs.map((v,i)=>'<div style="--a:'+(.06+.6*v/peak).toFixed(2)+'"><span>'+(i+1)+'</span><b>'+v.toFixed(1)+'</b></div>').join('')+'</div>');
  }
  const steals=t.stolenBases!=null&&t.caughtStealing!=null&&t.stolenBases+t.caughtStealing>0?t.stolenBases/(t.stolenBases+t.caughtStealing):null;
  // Steals and walks come from box scores, so they are averaged over the games that have one.
  const perBox=n=>n!=null&&t.boxGames?n/t.boxGames:null;
  const rows=[
    ['Score in the 1st inning',t.chartedInnings?t.scoredFirstInning+' of '+t.chartedInnings:'—',t.chartedInnings?t.scoredFirstInning/t.chartedInnings:null],
    ['Innings with 3+ runs',t.innings?t.bigInnings+' of '+t.innings:'—',t.innings?t.bigInnings/t.innings:null],
    ['Steals per game',scoutNumber(perBox(t.stolenBases),1)+' SB · '+scoutNumber(perBox(t.caughtStealing),1)+' CS',steals],
    ['Walks per game',scoutNumber(perBox(t.walks),1),null],
    ['Runs per game',scoutNumber(s.rfPerGame,1)+' scored · '+scoutNumber(s.raPerGame,1)+' allowed',null],
  ];
  html+=scoutSection('How they score','',rows.map(([label,value,ratio])=>'<div class="sr-m"><div class="sr-m-top"><span>'+label+'</span><b>'+value+'</b></div>'+(ratio==null?'':'<div class="sr-trk"><i style="width:'+Math.round(ratio*100)+'%"></i></div>')+'</div>').join(''));
  if(stars)html+='<p class="sr-foot">Rated '+scoutEsc(stars.stars)+' of 4 stars: '+stars.reasons.map(scoutEsc).join('; ')+'. 4 = won a gold bracket with only a couple of losses · 3 = gold semifinalist or better · 2 = typically in the gold bracket · 1 = C level, typically silver or below.</p>';
  return html;
}
// Hitters tab: every hitter sorted by average, with strikeouts highlighted.
function scoutHitters(view){
  const players=[...view.hitters].sort((a,b)=>(b.metrics.avg??-1)-(a.metrics.avg??-1)||(b.counts.AB??0)-(a.counts.AB??0)||a.id.localeCompare(b.id));
  if(!players.length)return '<p class="sr-msg">Batting stats are unavailable for these games. Games lists the games with box scores.</p>';
  const heads=['Hitter','AVG','OBP','SLG','H-AB','R','RBI','BB','K'];
  return '<div class="sr-tw"><table class="sr-t"><thead><tr>'+heads.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+players.map(p=>{
    const hot=p.badges.includes('Hitting .400+'),notes=p.badges.filter(b=>b!=='Hitting .400+');
    return '<tr><td><b>'+scoutPlayerName(p)+'</b><small>'+scoutPlural(p.games,'game')+(p.metrics.xbh!=null?' · '+p.metrics.xbh+' XBH':'')+'</small>'+scoutFlags(notes)+'</td>'
      +'<td>'+(hot?'<span class="sr-circ">'+scoutAvg(p.metrics.avg)+'</span>':scoutAvg(p.metrics.avg))+'</td><td>'+scoutAvg(p.metrics.obp)+'</td><td>'+scoutAvg(p.metrics.slg)+'</td>'
      +'<td>'+scoutNumber(p.counts.H)+'-'+scoutNumber(p.counts.AB)+'</td><td>'+scoutNumber(p.counts.R)+'</td><td>'+scoutNumber(p.counts.RBI)+'</td><td>'+scoutNumber(p.counts.BB)+'</td><td class="k">'+scoutNumber(p.counts.SO)+'</td></tr>';
  }).join('')+'</tbody></table></div>'
    +'<p class="sr-foot">H-AB = hits and at-bats. R = runs. RBI = runs batted in. BB = walks. K = strikeouts. Circled: hitting .400+ with at least 0.6 hits per game (minimum 3), and at-bats plus walks of at least 1.5 per game played. Extra-base production needs 0.25 extra-base hits per game (minimum 2). A dash means the stat is unavailable.</p>';
}
// Pitchers tab: one card per pitcher with their line, walks issued, and K%/BB% bars.
function scoutPitchers(view){
  const players=[...view.pitchers].sort((a,b)=>(b.metrics.outs??-1)-(a.metrics.outs??-1)||(a.metrics.era??Infinity)-(b.metrics.era??Infinity)||a.id.localeCompare(b.id));
  if(!players.length)return '<p class="sr-msg">Pitching stats are unavailable for these games.</p>';
  const bar=(label,value,cls)=>'<div class="sr-rate"><span>'+label+'</span><div class="sr-trk"><i'+(cls?' class="'+cls+'"':'')+' style="width:'+(value==null?0:Math.min(100,Math.round(value*200)))+'%"></i></div><b>'+scoutRate(value)+'</b></div>';
  return scoutSection('Pitching staff','by innings',players.map(p=>'<div class="sr-p"><div class="sr-p-top"><b>'+scoutPlayerName(p)+'</b><span>'+scoutPlural(p.games,'appearance')+'</span></div>'
    +'<div class="sr-p-line">'+[[scoutIp(p.metrics.outs),'IP'],[scoutNumber(p.metrics.era,2),'ERA'],[scoutNumber(p.metrics.whip,2),'WHIP'],[scoutNumber(p.counts.SO),'K'],[scoutNumber(p.counts.BB),'BB',true],[scoutNumber(p.metrics.bf),'BF']].map(([v,l,hl])=>'<div'+(hl?' class="hl"':'')+'><b>'+v+'</b><span>'+l+'</span></div>').join('')+'</div>'
    +bar('K%',p.metrics.kRate)+bar('BB%',p.metrics.bbRate,'bb')+(p.badges.length?'<div>'+scoutFlags(p.badges)+'</div>':'')+'</div>').join(''))
    +'<p class="sr-foot">IP = innings pitched (.1 is one out, .2 is two outs). ERA = earned runs per seven innings. WHIP = hits plus walks per inning. K = strikeouts. BB = walks issued. BF = batters faced. Highlights need two appearances and at least 4 batters faced per game in the report. Strikeout leader also needs a strikeout rate of 20% or more, and Low walk rate a walk rate of 15% or less. The starting pitcher is not confirmed.</p>';
}
// Games tab: each game with its opponent's class evidence, our past meetings, and scorebook notes.
function scoutGames(report,view){
  const canEdit=typeof editScoutingCompetition==='function';
  const day=value=>scoutDay(value).replace(' ','<br>');
  let html=scoutSection('Games','since Sep 1',view.games.length?view.games.map(g=>{
    const r=scoutResult(g.rf,g.ra),level=g.level||{};
    // An admin's class names the class it was set to, e.g. "C - admin verified".
    const basis=level.basis||'B by default';
    const why=[scoutEsc(basis==='Coach classification'?(level.group||'B')+' - '+SCOUT_BASIS[basis]:SCOUT_BASIS[basis]||basis)];
    if(level.source)why.push('<a href="'+scoutEsc(level.source)+'" target="_blank" rel="noopener">class source</a>');
    if(level.share!=null)why.push(level.largeLosses+'/'+level.games+' losses by 8+');
    if(level.reason)why.push(scoutEsc(level.reason));
    return '<div class="sr-g" data-scout-game-row="'+scoutEsc(g.id)+'" tabindex="-1"><div class="d">'+day(g.date)+'</div><div class="o">'+scoutEsc(g.opponent)+'<span class="sr-cls">'+scoutEsc(level.group||'B')+'</span>'
      +'<small>'+why.join(' · ')+'</small><small><a href="'+scoutEsc(g.source)+'" target="_blank" rel="noopener">Box score</a></small>'
      +(canEdit&&g.opponentPublicId?'<button type="button" class="sr-edit" data-scout-classify="'+scoutEsc(g.opponentPublicId)+'">Edit class…</button>':'')
      +'</div><span class="s '+r+'">'+r+' '+g.rf+'-'+g.ra+'</span></div>';
  }).join(''):'<p class="sr-msg">No completed games against this class since September 1.</p>')
    +'<p class="sr-foot">Teams without a confirmed class need at least 3 season games to be judged on results: C if they lost at least 25% of them by eight or more runs, otherwise B. With fewer games they count as B by default. A tournament or coach’s B/C class overrides this rule.</p>';
  const meetings=report.history.meetings||[];
  html+=scoutSection('Against us','this season',(meetings.length?meetings.map(m=>'<div class="sr-g"><div class="d">'+day(m.date)+'</div><div class="o">'+scoutEsc(m.event||'')+(m.source?'<small><a href="'+scoutEsc(m.source)+'" target="_blank" rel="noopener">Box score</a></small>':'')+'</div><span class="s '+scoutEsc(m.res)+'">'+scoutEsc(m.res)+' '+scoutEsc(m.score)+'</span></div>').join('')
    :'<p class="sr-msg">No previous games against us were found in the available records.</p>')+'<p class="sr-foot">'+report.history.warnings.map(scoutEsc).join(' ')+'</p>');
  const notes=[...report.warnings,...report.collection.games.flatMap(g=>g.warnings.map(w=>g.opponent+': '+w))];
  if(notes.length)html+=scoutSection('Scorebook notes','','<ul class="sr-list">'+notes.map(n=>'<li>'+scoutEsc(n)+'</li>').join('')+'</ul>');
  return html;
}
// The row under the team name: the NorCal class badge (only when NorCal names a class) and links to
// the team's GameChanger and NorCal pages (each only when known).
function scoutLinks(report){
  const link=(url,label)=>'<a class="sr-lk" href="'+scoutEsc(url)+'" target="_blank" rel="noopener">'+label+' <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i><span class="sr-only"> (opens in a new tab)</span></a>';
  const parts=[];
  if(report.norcal?.level)parts.push('<span class="sr-lvl'+(/^\d*\s*C$/.test(report.norcal.level)?' c':/rec/i.test(report.norcal.level)?' rec':'')+'">NorCal <b>'+scoutEsc(report.norcal.level)+'</b></span>');
  if(report.sourceUrl)parts.push(link(report.sourceUrl,'GameChanger'));
  if(report.norcal?.url)parts.push(link(report.norcal.url,'NorCal'));
  return parts.length?'<div class="sr-links">'+parts.join('')+'</div>':'';
}
// Redraws the whole modal for the loaded report, using the selected tab and class filter.
function renderScoutingReport(){
  const report=SCOUT_REPORT;if(!report)return;
  const view=report.views[SCOUT_GROUP],season=view.season;
  const updatedAt=[report.generatedAt,report.refreshedAt].filter(value=>Number.isFinite(Date.parse(value))).sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
  const firstPitch=Date.parse(report.opponent.firstPitch||'');
  const kicker='Scouting report'+(Number.isFinite(firstPitch)?' · '+new Date(firstPitch).toLocaleString('en-US',{timeZone:'America/Los_Angeles',weekday:'short',hour:'numeric',minute:'2-digit'}):'');
  const filter='<div class="sr-filt" role="group" aria-label="Opponent class">'+SCOUT_GROUPS.map(([key,label])=>'<button type="button" data-scout-group="'+key+'" aria-pressed="'+(key===SCOUT_GROUP)+'">'+label+'</button>').join('')+'</div>';
  const record=season.w+'–'+season.l+(season.t?'–'+season.t:'');
  const line='<div class="sr-line">'+[[record,season.t?'W–L–T':'W–L'],[scoutNumber(season.rfPerGame,1),'Runs / G'],[scoutNumber(season.raPerGame,1),'Allowed / G']].map(([v,l])=>'<div><b>'+v+'</b><span>'+l+'</span></div>').join('')+'</div>';
  const tabs='<div class="sr-ctrl" id="scoutCtrl"><div class="sr-tabs" role="tablist" aria-label="Scouting report sections">'+SCOUT_TABS.map(tab=>'<button type="button" id="scoutTab'+tab+'" role="tab" data-scout-tab="'+tab+'" aria-selected="'+(tab===SCOUT_TAB)+'" tabindex="'+(tab===SCOUT_TAB?'0':'-1')+'" aria-controls="scoutPanel">'+tab+'</button>').join('')+'</div></div>';
  let content=SCOUT_TAB==='Overview'?scoutOverview(view,report.summary,report.stars):SCOUT_TAB==='Hitters'?scoutHitters(view):SCOUT_TAB==='Pitchers'?scoutPitchers(view):scoutGames(report,view);
  if(SCOUT_TAB!=='Games'&&view.coverage.recentBoxScores<view.coverage.recentGames)content='<p class="sr-foot">Player stats are available for '+view.coverage.recentBoxScores+' of '+view.coverage.recentGames+' games.</p>'+content;
  content+='<p class="sr-upd">Updated '+scoutDate(updatedAt)+'</p>';
  document.getElementById('scoutView').innerHTML=scoutHeader(kicker,report.opponent.name,'',scoutLinks(report)+filter+line,scoutStars(report.stars))+tabs+'<div class="sr-body" id="scoutPanel" role="tabpanel" aria-labelledby="scoutTab'+SCOUT_TAB+'">'+content+'</div>';
}
// Switches to a tab, keeps the reader at the top of the new section, and focuses its tab button.
function scoutSelectTab(tab){
  SCOUT_TAB=tab;renderScoutingReport();
  // Start the new section at its top, just under the pinned tabs, when the reader had scrolled past them.
  const scroll=document.getElementById('scoutScroll'),ctrl=document.getElementById('scoutCtrl');
  if(scroll.scrollTop>ctrl.offsetTop)scroll.scrollTop=ctrl.offsetTop;
  document.getElementById('scoutTab'+tab).focus();
}
// Jumps from a Recent games tile to that game's row on the Games tab. Scrolls only when the row is
// hidden behind the pinned tabs or below the fold, then briefly highlights it.
function scoutShowGame(id){
  scoutSelectTab('Games');
  const row=[...document.querySelectorAll('[data-scout-game-row]')].find(node=>node.dataset.scoutGameRow===id);
  if(!row)return;
  const scroll=document.getElementById('scoutScroll'),ctrl=document.getElementById('scoutCtrl');
  const box=row.getBoundingClientRect(),view=scroll.getBoundingClientRect();
  // Place the row just under the tabs, which stay pinned once the card scrolls past them.
  if(box.top<ctrl.getBoundingClientRect().bottom||box.bottom>view.bottom)scroll.scrollTop=box.top-view.top+scroll.scrollTop-ctrl.offsetHeight-8;
  row.focus({preventScroll:true});
  row.classList.remove('sr-flash');void row.offsetWidth;row.classList.add('sr-flash');
}
// Handles clicks: backdrop or close button, tab switches, Recent games tiles, class filter, and the
// admin Edit class button.
document.getElementById('scoutModal').addEventListener('click',e=>{
  if(e.target===e.currentTarget||e.target.closest('#scoutClose'))return closeScoutingReport();
  const classification=e.target.closest('[data-scout-classify]');
  if(classification&&typeof editScoutingCompetition==='function')editScoutingCompetition(classification.dataset.scoutClassify);
  const tab=e.target.closest('[data-scout-tab]');if(tab)scoutSelectTab(tab.dataset.scoutTab);
  const game=e.target.closest('[data-scout-game]');if(game)scoutShowGame(game.dataset.scoutGame);
  const group=e.target.closest('[data-scout-group]');
  if(group){SCOUT_GROUP=group.dataset.scoutGroup;renderScoutingReport();document.querySelector('[data-scout-group="'+SCOUT_GROUP+'"]').focus();}
});
// Keyboard support: Escape closes, arrow keys move between tabs, and Tab stays inside the modal.
document.getElementById('scoutModal').addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();closeScoutingReport();return;}
  const modal=e.currentTarget;
  if(e.target.matches('[role=tab]')&&['ArrowLeft','ArrowRight'].includes(e.key)){
    e.preventDefault();const i=SCOUT_TABS.indexOf(SCOUT_TAB);scoutSelectTab(SCOUT_TABS[(i+(e.key==='ArrowRight'?1:SCOUT_TABS.length-1))%SCOUT_TABS.length]);
  }
  if(e.key==='Tab'){
    const controls=[...modal.querySelectorAll('button,a,select')].filter(n=>n.tabIndex>=0),first=controls[0],last=controls.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }
});
