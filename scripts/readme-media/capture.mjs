// Captures the README screenshots and demo video from the fictional demo data.
//
//   cd scripts/readme-media && npm install && node capture.mjs [--shots] [--video]
//
// Writes docs/media/*.png, docs/media/demo.mp4 and docs/media/demo.gif (both by default). Uses the
// installed Chrome (Playwright's "chrome" channel), falling back to Playwright's own Chromium.
// The page clock is frozen at a moment in the tournament (SCENARIO_TIMES), so the live game,
// countdowns and day tabs look the same on every run. ffmpeg must be on PATH for the video.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from './demo-server.mjs';
import { SCENARIO_TIMES, CONTEXT_PATH, weather } from './demo-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', '..', 'docs', 'media');
const args = new Set(process.argv.slice(2));
const wantShots = args.has('--shots') || !args.has('--video');
const wantVideo = args.has('--video') || !args.has('--shots');
const PHONE = { width:390, height:844 };
fs.mkdirSync(OUT, { recursive:true });

const { server, state, url } = await startDemoServer({ port:3079 });
const launch = (args = []) => chromium.launch({ channel:'chrome', args }).catch(() => chromium.launch({ args }));
const browser = await launch();

// A phone-sized page at the scenario's moment, with the weather API answered locally.
async function openPage(scenario, { viewport = PHONE, record = false, delay = 0, scale = 2, from = browser } = {}) {
  state.scenario = scenario;
  state.snapshotDelayMs = delay;
  const mobile = viewport.width < 768;
  const context = await from.newContext({
    viewport, deviceScaleFactor:scale, isMobile:mobile, hasTouch:mobile, serviceWorkers:'block',
    locale:'en-US', timezoneId:'America/Los_Angeles',
  });
  const page = await context.newPage();
  await page.clock.install({ time:new Date(SCENARIO_TIMES[scenario]) });
  await page.route(/open-meteo\.com/, route => route.fulfill({ json:weather() }));
  // Keep the screenshots on our fictional data only: no live provider or social requests.
  await page.route(/registerplay\.com|gc\.com|tourneymachine\.com|instagram\.com/, route => route.abort());
  await page.addInitScript(() => { try { localStorage.setItem('mgLastName', 'Maya'); } catch {} });
  const recorder = record ? await startRecorder(page, viewport, scale) : null;
  await page.goto(url + CONTEXT_PATH);
  return { context, page, recorder };
}

// Records the page with Chrome's screencast (Playwright's own video is limited to CSS pixels; the
// screencast reaches device pixels only in a browser launched with a forced scale factor). Chrome sends a frame only when the page changes, so each frame is
// held until the next one's timestamp; `stop` writes an MP4 and a GIF from them.
async function startRecorder(page, viewport, scale) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', frame => {
    frames.push({ data:frame.data, ts:frame.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId:frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format:'jpeg', quality:92,
    maxWidth:viewport.width * scale, maxHeight:viewport.height * scale, everyNthFrame:1 });
  return {
    async stop(mp4, gif) {
      await cdp.send('Page.stopScreencast');
      const dir = fs.mkdtempSync(path.join(HERE, '.frames-'));
      try {
        const list = frames.map((f, i) => {
          const name = `f${String(i).padStart(5, '0')}.jpg`;
          fs.writeFileSync(path.join(dir, name), Buffer.from(f.data, 'base64'));
          const next = frames[i + 1]?.ts ?? f.ts + 1;
          return `file '${name}'\nduration ${Math.max(0.001, next - f.ts).toFixed(4)}`;
        });
        list.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
        fs.writeFileSync(path.join(dir, 'frames.txt'), list.join('\n'));
        const input = ['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt')];
        const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-vf', `fps=30,${even}`, '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'slow', '-movflags', '+faststart', mp4]);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-vf',
          'fps=10,scale=300:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle', gif]);
      } finally {
        fs.rmSync(dir, { recursive:true, force:true });
      }
    },
  };
}
const loaded = page => page.waitForSelector('#appLoader[hidden]', { state:'attached', timeout:30000 });
const pause = (page, ms) => page.waitForTimeout(ms);

// Scrolls so the element's top sits `offset` px below the top of the viewport.
async function scrollTo(page, selector, { offset = 8, smooth = false } = {}) {
  await page.evaluate(([sel, off, behavior]) => {
    const el = document.querySelector(sel);
    window.scrollTo({ top:el.getBoundingClientRect().top + scrollY - off, behavior });
  }, [selector, offset, smooth ? 'smooth' : 'instant']);
  await pause(page, smooth ? 900 : 150);
}
const shot = (page, name) => page.screenshot({ path:path.join(OUT, name) });
// Hides the floating chat button where it would cover the content being shown.
const showFab = (page, on) => page.evaluate(visible => { document.getElementById('chatFab').style.visibility = visible ? '' : 'hidden'; }, on);

// A visible tap ripple for the video, then the click itself.
async function tap(page, locator, { video = false } = {}) {
  const target = page.locator(locator).first();
  await target.scrollIntoViewIfNeeded();
  if (video) {
    const box = await target.boundingBox();
    await page.evaluate(([x, y]) => {
      const dot = document.createElement('div');
      dot.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;`
        + 'background:rgba(255,255,255,.55);border:2px solid rgba(0,0,0,.25);z-index:2147483647;pointer-events:none;'
        + 'transform:scale(.4);opacity:1;transition:transform .45s ease-out,opacity .6s ease-out;';
      document.body.appendChild(dot);
      requestAnimationFrame(() => { dot.style.transform = 'scale(1.1)'; dot.style.opacity = '0'; });
      setTimeout(() => dot.remove(), 700);
    }, [box.x + box.width / 2, box.y + box.height / 2]);
    await pause(page, 220);
  }
  await target.click();
}

async function captureShots() {
  // 1. The loading screen, held open by a slow snapshot response.
  {
    const { context, page } = await openPage('saturday', { delay:6000 });
    await pause(page, 2200);
    await shot(page, '01-loading.png');
    await context.close();
  }
  // Saturday afternoon: pool play, our game live.
  {
    const { context, page } = await openPage('saturday');
    await loaded(page);
    await pause(page, 700);                      // mid-way through the #1-rank fireworks
    await shot(page, '02-dashboard.png');

    await showFab(page, false);
    await scrollTo(page, '#scoreboardCard');
    await pause(page, 300);
    await page.evaluate(() => {                   // centre the live game in the shot
      const live = [...document.querySelectorAll('#scoreboardCard *')].find(n => n.children.length === 0 && n.textContent.trim() === 'LIVE');
      live?.closest('.sb-game, [class*=game]')?.scrollIntoView({ block:'center' });
    });
    await pause(page, 200);
    await shot(page, '03-live-scoreboard.png');

    await scrollTo(page, '#standingsCard');
    await shot(page, '05-standings.png');

    // Chat assistant.
    await showFab(page, true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await tap(page, '#chatFab');
    await pause(page, 400);
    await tap(page, '#chatSuggest button');
    await page.waitForSelector('#chatMsgs .chat-msg.bot ~ .chat-msg.bot', { timeout:10000 });
    await pause(page, 300);
    await shot(page, '09-chat.png');
    await context.close();
  }
  // Sunday evening: brackets, our Premier final live.
  {
    const { context, page } = await openPage('sunday');
    await loaded(page);
    await pause(page, 600);
    await shot(page, '10-championship-day.png');

    // Scouting report for the championship opponent, from the Upcoming Games card.
    await tap(page, '#nextGameCard .scout-strip');
    await page.waitForSelector('#scoutModal .sr-tabs');
    await page.evaluate(() => document.fonts.ready);
    await pause(page, 500);
    await shot(page, '06-scouting-overview.png');
    await tap(page, '[data-scout-tab="Hitters"]');
    await pause(page, 300);
    await shot(page, '07-scouting-hitters.png');
    await tap(page, '[data-scout-tab="Pitchers"]');
    await pause(page, 300);
    await shot(page, '08-scouting-pitchers.png');
    await page.keyboard.press('Escape');

    // A completed tournament, opened from the season list.
    await tap(page, '#seasonDiv .t-row-btn');
    await page.waitForSelector('#historyBody .history-card');
    await pause(page, 500);
    await shot(page, '12-past-tournament.png');
    await context.close();
  }
  // Home Run Derby: batter select, a pitch in flight, and the leaderboard.
  {
    const { context, page } = await openPage('saturday');
    await loaded(page);
    await tap(page, '#mgPromoBar');
    await tap(page, '#mgNameGo');
    await page.waitForSelector('.mg-roster-btn');
    await pause(page, 300);
    await shot(page, '13-derby-select.png');
    await tap(page, '.mg-roster-btn');
    await page.waitForSelector('#mgSwingBtn:not([disabled])', { timeout:15000 });
    await pause(page, 350);
    await shot(page, '14-derby-pitch.png');
    await page.evaluate(() => closeMiniGame());
    await tap(page, '#mgPromoBar');
    await tap(page, '#mgNameGo');
    await tap(page, '#mgHsLink');
    await pause(page, 1200);
    await shot(page, '15-derby-scores.png');
    await context.close();
  }
  // Saturday's view of Sunday at desktop width: brackets projected live from the pool standings.
  {
    const { context, page } = await openPage('saturday', { viewport:{ width:1280, height:900 }, scale:1.5 });
    await loaded(page);
    await showFab(page, false);
    await tap(page, '#sbTab-sun');
    await pause(page, 900);
    await page.locator('#sbPanel-sun').screenshot({ path:path.join(OUT, '04-projected-bracket.png') });
    await context.close();
  }
  // Desktop: the Sunday dashboard at a laptop width, and the full live bracket tree.
  {
    const { context, page } = await openPage('sunday', { viewport:{ width:1280, height:900 }, scale:1.5 });
    await loaded(page);
    await pause(page, 600);
    await shot(page, '16-desktop.png');
    await showFab(page, false);
    await tap(page, '#sbTab-sun');
    await pause(page, 900);
    await page.locator('#bktPanel-premier').evaluate(el => el.closest('[id^=sbPanel]').scrollIntoView());
    await page.locator('#sbPanel-sun').screenshot({ path:path.join(OUT, '11-bracket.png') });
    await context.close();
  }
}

// The walkthrough video: load → live game → standings → scouting → chat → derby (about 40s).
async function captureVideo() {
  const sharp = await launch(['--force-device-scale-factor=2']);
  const { context, page, recorder } = await openPage('saturday', { record:true, delay:2400, scale:2, from:sharp });
  const v = { video:true };
  await loaded(page);
  await pause(page, 1600);
  // Swipe the Upcoming Games pager to the next game and back.
  const swipe = left => page.evaluate(dx => document.getElementById('nxtRail').scrollBy({ left:dx, behavior:'smooth' }), left);
  await swipe(400);
  await pause(page, 1300);
  await swipe(-400);
  await pause(page, 700);
  // The live game on the scoreboard, then the pool standings.
  await page.evaluate(() => {
    const live = [...document.querySelectorAll('#scoreboardCard *')].find(n => n.children.length === 0 && n.textContent.trim() === 'LIVE');
    const top = live.getBoundingClientRect().top + scrollY - 260;
    window.scrollTo({ top, behavior:'smooth' });
  });
  await pause(page, 2000);
  await scrollTo(page, '#standingsCard', { smooth:true });
  await pause(page, 1600);
  // Scouting report for the opponent we're playing now.
  await scrollTo(page, '#nextGameCard', { smooth:true });
  await tap(page, '#nextGameCard .scout-strip', v);
  await page.waitForSelector('#scoutModal .sr-tabs');
  await pause(page, 1500);
  await page.evaluate(() => document.getElementById('scoutScroll').scrollBy({ top:480, behavior:'smooth' }));
  await pause(page, 1300);
  await tap(page, '[data-scout-tab="Hitters"]', v);
  await pause(page, 1400);
  await tap(page, '[data-scout-tab="Pitchers"]', v);
  await pause(page, 1400);
  await tap(page, '#scoutClose', v);
  await pause(page, 400);
  // Ask the assistant.
  await tap(page, '#chatFab', v);
  await pause(page, 700);
  await tap(page, '#chatSuggest button', v);
  await page.waitForSelector('#chatMsgs .chat-msg.bot ~ .chat-msg.bot', { timeout:10000 });
  await pause(page, 2400);
  await page.evaluate(() => window.toggleChat());
  await page.evaluate(() => window.scrollTo({ top:0, behavior:'smooth' }));
  await pause(page, 600);
  // Home Run Derby: three pitches, each swung at the moment the ball reaches the plate.
  await tap(page, '#mgPromoBar', v);
  await pause(page, 900);
  await tap(page, '#mgNameGo', v);
  await pause(page, 700);
  await tap(page, '.mg-roster-btn:nth-child(2)', v);
  for (let i = 0; i < 3; i++) {
    await page.waitForSelector('#mgSwingBtn:not([disabled])', { timeout:20000 });
    // Swing when the ball reaches the plate: the meter's cursor animation runs for the whole
    // meter, and the plate is at the --perfect fraction of it.
    await page.waitForFunction(() => document.getElementById('mgTimingMeter')?.getAnimations({ subtree:true }).some(x => x.playState === 'running'), null, { polling:'raf', timeout:20000 });
    await page.evaluate(() => new Promise(resolve => {
      const meter = document.getElementById('mgTimingMeter');
      const animation = meter.getAnimations({ subtree:true }).find(x => x.playState === 'running');
      const plate = parseFloat(meter.style.getPropertyValue('--meterdur')) * parseFloat(meter.style.getPropertyValue('--perfect')) / 100;
      const check = () => {
        if (animation.currentTime >= plate - 12) {
          document.getElementById('mgSwingBtn')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true }));
          resolve();
        } else requestAnimationFrame(check);
      };
      check();
    }));
    await pause(page, 2300);
  }
  await pause(page, 600);
  await recorder.stop(path.join(OUT, 'demo.mp4'), path.join(OUT, 'demo.gif'));
  await context.close();
  await sharp.close();
}

try {
  if (wantShots) await captureShots();
  if (wantVideo) await captureVideo();
  console.log('Wrote', fs.readdirSync(OUT).map(f => 'docs/media/' + f).join('\n      '));
} finally {
  await browser.close();
  server.close();
}
