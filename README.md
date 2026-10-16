# The Coterie Cup

One-button ragdoll football as a 1v1 knockout cup for the office. Everyone plays on their own laptop or phone, the matches run peer to peer, and the bracket fills in on the big screen until one of you lifts the cup.

## Running the cup in a 30-minute meeting

1. **Before the meeting**, open the site and press **Start a cup**. You land on the admin page. Keep that link to yourself, because it starts the draw and changes results.
2. **When the meeting starts**, open the **big screen** from the admin page and share that window in your video call (in Zoom, tick *Share sound* if you want the crowd noise). It shows a QR code, the code and everyone who has joined, with a CPU match playing while people arrive. Only the organiser can open it.
3. **Everyone scans the QR code** and picks a name, a flag and a kit colour. While they wait, they can warm up against the CPU.
4. **Press "Make the draw"** on the big screen or the admin page. Each player sees **Your match is ready → Play**. Both players press **I'm ready** and the match starts.
5. **Every match is on the big screen at once**, in a grid. Click a match, or press its number, to fill the screen with it; **Esc** or **All matches** goes back, and ← → move between matches. Only the match filling the screen plays sound. **Bracket** at the top switches to the bracket; the matches stay connected behind it.
6. **Results go in by themselves.** Winners see their next match appear as soon as their opponent is known. Players only open their own matches: everyone follows the rest on the shared screen.

With 16 players there are 4 rounds. The default rules are:

- **Matches:** first to 3 goals, with a 3-minute limit and then golden goal.
- **Final:** first to 5 goals, with a 5-minute limit.

In the worst case that is about 20 minutes of play, so it fits a 30-minute slot. If time is short, set *first to 2* and a *2-minute limit* on the admin page before the draw.

**Controls:**

- **Keyboard:** <kbd>Space</kbd>, <kbd>W</kbd> or <kbd>↑</kbd> jumps and kicks with both of your players. <kbd>A</kbd> or <kbd>D</kbd> moves just one. <kbd>M</kbd> mutes.
- **Phone:** tap anywhere. Turn the phone sideways for a bigger pitch.

### When something goes wrong

| Problem | What to do |
| --- | --- |
| Two players can't connect, usually on a locked-down office network | **The fix:** set up the free Cloudflare relay (see below). **On the day:** the left-hand player clicks **Play on this device** and both play side by side on one keyboard. Or the organiser presses **Play here** on the big screen. |
| Someone doesn't turn up | Admin page → **Manage** on that match → *goes through* (walkover). |
| Someone is listed twice (Ana and Ana 2), say their browser froze and they joined again from another one | Before the draw: on the big screen or the admin page, press **×** next to the entry without a green dot, then **Remove**. The other entry becomes plain Ana again. After the draw nobody new can join, so ask them to reopen the cup in the browser they joined with: their place is kept there. |
| A laptop drops out mid-match | The match pauses and picks up again when they reconnect, usually within 10 seconds of their network coming back. If the left-hand player reloads, the match carries on from the saved score. |
| The other player's men sometimes slide into place | That is prediction at work over a long distance (see *Lag* below): your own men react the moment you press, and your opponent's jumps reach you a moment late. If it ever looks wrong, tick **Equal delay instead of prediction** in the admin page's rules: both players then see their match equally late and nothing slides. |
| A result is wrong | Admin page → **Manage** → enter the right score. This works until the next match has started. |
| You want to start again | Admin page → **Back to the lobby** keeps the players and clears the bracket. |

## Deploying on Vercel

1. Put this folder in a GitHub repository.
2. On [vercel.com](https://vercel.com), choose **Add New → Project** and import the repository. The defaults are right: the framework is Next.js and there are no build settings to change.
3. In the new project, open **Storage**. Pick **Upstash for Redis** from the Marketplace, create a database on the free plan and connect it to the project for all environments. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
4. Redeploy (**Deployments → ⋯ → Redeploy**) so the app picks the variables up.
5. **Strongly recommended:** set up a relay for players whose network blocks direct connections (office networks and VPNs, some home routers, phones on mobile data). You can check it is on: `/api/ice` on your site says `"relay":true`.
   1. In the Cloudflare dashboard, open **Realtime → TURN Server** and create a TURN key.
   2. In Vercel, add `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` under **Settings → Environment Variables**.
   3. Redeploy.

Without step 3, the deployed app refuses to create cups and says why. Its fallback memory store would give every server instance its own copy of the data.

**Usage:** with 16 players and the big screen showing every match, the cup uses about 1,300 Redis commands a minute, so roughly 40,000 for a 30-minute meeting. Upstash's free plan allows 500,000 a month. Pages slow their polling once a cup is over or the tab is in the background.

## Running it locally

```bash
npm install
npm run dev          # http://localhost:3000
```

Without the Redis variables it keeps everything in memory, which is fine for one local server. To play against yourself, open the cup in a normal window and in a private window: each browser profile is one player.

## Tests

```bash
npm test                                   # bracket logic: seeding, byes, results, corrections
```

The other tests need a running server. `test/api.mjs` only needs `npm run build && npm start`; it checks every API route with good and bad input, who may do what, and many requests at once. The browser tests drive real Chromium windows: CPU bots join, connect peer to peer, play and report. They need Playwright (`npm i -D playwright`) and a build with the test switch on:

```bash
NEXT_PUBLIC_BOTS=1 npm run build && npm start
node test/api.mjs                           # every API route: input, permissions, simultaneous writes
node test/features.mjs                      # every page and button: practice, create, admin, joining, the player page,
                                            # keys, touch, mute, golden goal, time limits, phones, the big-screen lobby
node test/scenarios.mjs                     # reloads, dropped connections, the organiser watching, one-device matches,
                                            # walkovers, the big-screen grid, the dead-ball ring online
PLAYERS=16 node test/e2e.mjs                # a whole cup, 8 matches at a time, every match on the big screen
node test/rounds.mjs                        # every ball and crazy round, drawn and played
node test/lag.mjs 75 15                     # 75 ms each way, 15 ms jitter: how late presses show, on each screen
BASE=http://localhost:3000 node test/smoke.mjs    # screenshots of every page
node test/physics.mjs 120 6                 # CPU v CPU without drawing: goals, falls, jump heights, hop distances
HOPS=1 node test/physics.mjs 0 8            # each man hopping at the peak of his sway, forward and back
MODS=1 node test/physics.mjs 600 3          # crazy rounds on, a long soak
```

To run them against Redis instead of the memory store, start the server with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set (a free Upstash database works).

`?bot=0.7` only works in builds made with `NEXT_PUBLIC_BOTS=1`. That way nobody can let the CPU play for them in the real cup. The same goes for `?lag=75&jitter=15` on a match page (holds back what that side receives, like a long way round the world) and `?net=fair` (prediction off, like the *Equal delay* rule).

## How it is built

- **Next.js 16 (App Router), React 19 and TypeScript.** Every page is a client component that polls `GET /api/t/{code}` every 2 seconds.
- **`lib/engine/`** holds the match engine, which runs on [planck.js](https://piqnt.com/planck.js/) (a Box2D port). Each team has two men: the one nearest his own goal is the keeper (darker kit, gloves, number 1), who jumps higher. How far the men sway and how high the keeper jumps are set in `TUNE` at the top of `createGame`.
  - **Dead balls:** a ball lying still is dropped again from the sky after 7 seconds (`TUNE.deadT`). The wait runs at half speed while a man is right next to the ball (`nearRate`), so someone on his way can still save it. A ball stuck on a goal roof waits 2.5 seconds (`roofT`). In the last couple of seconds a gold ring winds down around the ball.
  - **Own goals:** the banner says *Own goal* only when the scoring side hasn't touched the ball in the last 1.5 seconds (`OWN_T`), so a shot that brushes the keeper on its way in still counts as the shooter's goal.
  - The engine has these modes:
    - `practice` and `local2p`: simulated on this device.
    - `demo`: CPU against CPU.
    - `host`: simulates and streams snapshots.
    - `guest`: runs its own copy of the match a little ahead of the host (prediction, below).
    - `spectator`: draws the host's snapshots. Spectators are the organiser's big screen: watching needs the admin key, and each pitch in the grid can draw less often, at lower resolution, or not at all while another match fills the screen.
- **`lib/net/link.js`** is the peer-to-peer link (WebRTC data channels).
  - The left-hand player (the host) runs the physics. It streams binary snapshots 60 times a second on an unordered, no-retry channel, and events and button presses on a reliable one.
  - Signaling goes through small mailboxes in Redis (`/api/t/{code}/m/{id}/signal`). Each side gathers its network candidates in full first, so a connection needs exactly one offer and one answer.
- **Lag:** between New Jersey and Buenos Aires a message takes about 150 ms there and back, and no buffer can make that shorter. So the game predicts:
  - **The host** draws its match as it happens, so its own presses show at once.
  - **The guest** runs its own copy of the match a little ahead of the host: far enough that a press made now reaches the host before the host gets to that tick. Its own men react at once. Each press is stamped with that tick, and the host applies it on exactly that tick, so both matches agree.
  - 20 times a second the host also sends the guest its **full state**: every body with its speed, each man's timers, and what the physics solver carries from one step to the next. When the copy had the same at that tick, which is most of the time, nothing happens. When the host did something the copy couldn't know (a press, usually), the copy goes back to the host's state and runs the ticks since again. Anything that moved because of that slides into place over about a tenth of a second.
  - Measured with 75 ms each way plus 15 ms of jitter (`test/lag.mjs`): a press shows on the presser's own screen within a frame (it was about 300 ms before, for both players). The other player's presses show 130–160 ms after they press (220–390 ms before).
  - **Equal delay** (a rule on the admin page, for when prediction misbehaves) switches this off: the guest draws the host's snapshots with just enough buffer for its connection, and the host waits as long, so both react equally late. A jump still uses the lean the player saw when pressing.
- **`lib/tournament.ts`** is the knockout bracket, written as pure functions over one JSON document. It covers seeding, byes, advancing and organiser corrections.
- **`lib/store.ts`** connects to Upstash Redis. Updates are compare-and-swap through a small Lua script, so simultaneous results never overwrite each other. It falls back to memory for local development.
- **API routes:**
  - Create a cup: `POST /api/t`
  - Read the state: `GET /api/t/{code}`
  - Join: `POST /api/t/{code}/join`
  - Organiser actions: `POST /api/t/{code}/admin`
  - The host's kick-off, goal and result reports: `POST /api/t/{code}/m/{id}/report`
  - Signaling: `/api/t/{code}/m/{id}/signal`
  - Relay credentials: `GET /api/ice`

Players are identified by a random token kept in their browser. The server stores only its hash, and the same goes for the admin key.

## Credits

- Flags: [flag-icons](https://github.com/lipis/flag-icons) (MIT, see `public/flags/LICENSE.txt`).
- Fonts: Lilita One and Nunito (SIL Open Font License, see `app/fonts`).
