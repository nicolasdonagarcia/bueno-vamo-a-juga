# The Coterie Cup

One-button ragdoll football as a 1v1 knockout cup for the office. Everyone plays on their own laptop or phone, one match at a time, and the whole meeting watches that match live, on the big screen or on their own screen, until one of you lifts the cup.

The live match runs on a small match server next to the site, so both players see the same match and the big screen draws it straight from there. It all fits on one DigitalOcean droplet, or on your own computer for a cup on the office Wi-Fi.

## Running the cup in a 30-minute meeting

1. **Before the meeting**, open the site and press **Start a cup**. You land on the admin page. Keep that link to yourself, because it starts the draw and changes results.
2. **When the meeting starts**, open the **big screen** from the admin page and share that window in your video call (in Zoom, tick *Share sound* if you want the crowd noise). It shows a QR code, the code and everyone who has joined, with a CPU match playing while people arrive. Only the organiser can open it. Everyone else can watch the same live match on their own screen, the **live view** (`/t/{code}/watch`): players press **Watch live** on their page, and the admin page has its link to share with anyone who isn't playing. It has none of the organiser's controls.
3. **Everyone scans the QR code** and picks a name, a flag and a kit colour. While they wait, they can warm up against the CPU.
4. **Press "Make the draw"** on the big screen or the admin page. **One match is played at a time**, in bracket order. The first pair sees **Your match is ready → Play**; everyone else sees how many matches come before theirs. Both players press **I'm ready** and the match starts.
5. **The big screen shows the match on now**, live and with sound, and who's up next. When it ends, the result stays up for a few seconds and then the next match takes over. **Bracket** at the top switches to the bracket.
6. **Results go in by themselves.** When it's their turn, the next pair's page beeps and shows **Play** (a page already open on their match starts it by itself), and winners see their next match as soon as their opponent is known. Players only play their own matches; everyone watches the rest on the shared screen or in the live view, which also calls a player who is watching when their own match is ready.

The default rules are:

- **Matches:** first to 3 goals, with a 90-second limit and then golden goal.
- **Final:** first to 5 goals, with a 150-second limit.

With 16 players that is 15 matches, one after another. If every match ran to its limit, with half a minute between matches, the cup would take about 31 minutes; most matches end at 3 goals well before the limit. The admin page shows this estimate for the players who have joined. If time is tight, set *first to 2* and a *1-minute limit* before the draw.

**Controls:**

- **Keyboard:** <kbd>Space</kbd>, <kbd>W</kbd> or <kbd>↑</kbd> jumps and kicks with both of your players. <kbd>A</kbd> or <kbd>D</kbd> moves just one. <kbd>M</kbd> mutes.
- **Phone:** tap anywhere. Turn the phone sideways for a bigger pitch.

### When something goes wrong

| Problem | What to do |
| --- | --- |
| Someone isn't there when their match is called | Admin page → **Manage** on another match → **Play this one next**, and come back to theirs later. The pages of the match you skipped leave it until it's their turn again, so it can't kick off alongside the one you called. If they don't turn up at all: **Manage** → *goes through* (walkover). |
| Someone is listed twice (Ana and Ana 2), say their browser froze and they joined again from another one | Before the draw: on the big screen or the admin page, press **×** next to the entry without a green dot, then **Remove**. The other entry becomes plain Ana again. After the draw nobody new can join, so ask them to reopen the cup in the browser they joined with: their place is kept there. |
| A laptop drops out mid-match | The match pauses and carries on 3 seconds after they're back. A player who reloads goes straight back into the match where it is. |
| The match server restarts mid-match (a deploy with `--now`, or a crash) | The pages reconnect by themselves and the match carries on from the saved score, with the clock starting again. |
| A player can't reach the match server | It's an ordinary secure connection to the same address as the site, so office networks let it through. On the day, the left-hand player clicks **Play on this device** and both play side by side on one keyboard. Or the organiser presses **Play here** on the big screen. |
| The other player's men sometimes move a little fast or slide into place | That is prediction at work (see *Lag* below). Your own men react as soon as you press (after the input delay, 33 ms by default); the other player's jumps reach you a moment late, then play from the start a little faster until they have caught up, or, right next to the ball or your men, slide into place. The line under the pitch shows the numbers: send them with **Copy the numbers**. A higher **input delay** in the admin page's rules means fewer corrections, and your own men answer a few hundredths of a second later. |
| A result is wrong | Admin page → **Manage** → enter the right score. This works until the next match has started. |
| You want to start again | Admin page → **Back to the lobby** keeps the players and clears the bracket. |
| You want the old peer-to-peer matches back | Admin page → rules → **Online matches run**: *peer to peer*. Each match then runs in the left-hand player's browser, as before the match server. |

## Running it on your own computer

You need Node.js 22.18 or later (it runs the match server's TypeScript as it is).

```bash
npm install
npm run dev          # the site on http://localhost:3000, the match server on port 3001
```

`npm run dev` starts both and restarts the match server when its code changes. Without Redis it keeps everything in memory, which is fine for one computer. To play against yourself, open the cup in a normal window and in a private window: each browser profile is one player.

**A cup on the office Wi-Fi:** run `npm run build` and then `npm start`, which runs the built site and the match server together. Everyone opens `http://<your computer's address>:3000` (on a Mac, *System Settings → Wi-Fi → Details* shows the address), and the match server is reached on the same address, port 3001. If your computer's firewall asks, allow incoming connections for Node. The cup is lost when you stop it; set `REDIS_URL` to keep it.

To change anything, copy `.env.example` to `.env.local`: it lists every setting.

## Running it on DigitalOcean

Everything runs on one droplet: the site, the match server, Redis, and Caddy in front for HTTPS.

1. **Create a droplet:** Ubuntu 24.04, *Basic*, *Regular* with 2 GB of memory and 1 CPU (about $12 a month at the time of writing). Pick the region closest to most players: the match server's distance is everyone's lag. Add your SSH key.
2. **Point a domain at it:** an `A` record for, say, `cup.example.com` with the droplet's address. Caddy gets the HTTPS certificate by itself once the name resolves to the droplet.
3. **Run the setup script** on the droplet, as root:

   ```bash
   ssh root@<droplet address>
   curl -fsSL https://raw.githubusercontent.com/nicolasdonagarcia/bueno-vamo-a-juga/main/deploy/setup.sh -o setup.sh
   bash setup.sh cup.example.com https://github.com/nicolasdonagarcia/bueno-vamo-a-juga.git main
   ```

   It installs Node.js 24, Redis (saved to disk every second), Caddy and the two services, makes a random `MATCH_SECRET`, builds the site and starts everything, then opens only SSH, HTTP and HTTPS in the firewall. Without a domain it serves plain HTTP on the droplet's address, which is fine for a test. Deploying a branch other than `main` (`match-server`, say): put its name in place of `main`, in the address and at the end.
4. **Updates:** push to the branch, then run `ssh root@<droplet address> bash /srv/cup/deploy/deploy.sh`. The site restarts in a few seconds and pages carry on by themselves. The match server only restarts when its own code changed, and not while a match is live: run the script again after the match, or add `--now`.

**What runs where:**

| | |
| --- | --- |
| `cup-app` | The site and its API (`next start`), on 127.0.0.1:3000 |
| `cup-match` | The match server, on 127.0.0.1:3001 |
| `redis-server` | The cups, on 127.0.0.1:6379 |
| `caddy` | HTTPS on ports 80 and 443: `/ws` goes to the match server, the rest to the site |
| `/etc/cup.env` | The settings both services read (`systemctl restart cup-app cup-match` after a change) |

Logs: `journalctl -u cup-match -f` (or `cup-app`). `curl -s localhost:3001/health` on the droplet lists the matches the match server has open.

## Tests

```bash
npm test                 # bracket logic: seeding, byes, the playing order, results, corrections
npm run test:server      # the match server against two CPU players, one near and one far away:
                         # every ball and crazy round, two whole matches, the results it reports,
                         # a player whose network goes silent, the match server restarting mid-match
```

The other tests need a running site. `test/api.mjs` only needs `npm run build && npm start`; it checks every API route with good and bad input, who may do what, and many requests at once. The browser tests drive real Chromium windows: CPU bots join, connect, play and report. They need Playwright (`npm i -D playwright`) and a build with the test switch on:

```bash
NEXT_PUBLIC_BOTS=1 npm run build && npm start
node test/api.mjs                           # every API route: input, permissions, tickets, watching, simultaneous writes,
                                            # a 10-player cup one match at a time
node test/features.mjs                      # every page and button: practice, create, admin, joining, the player page,
                                            # keys, touch, mute, golden goal, time limits, phones, the big-screen lobby
RESTART_MATCH_SERVER='pkill -TERM -f "server/mai[n].ts"' node test/scenarios.mjs
                                            # reloads, dropped connections, the match server restarting (npm start
                                            # brings it back), the organiser watching, one-device matches, walkovers,
                                            # the big screen, the live view, calling another match while a pair waits,
                                            # peer to peer
PLAYERS=16 node test/e2e.mjs                # a whole cup, one match at a time, the big screen and the live view
                                            # following along
node test/rounds.mjs                        # every ball and crazy round, drawn and played
NEAR=5 node test/lag.mjs 75 15              # one player 5 ms from the match server, the other 75 ms and 15 ms
                                            # of jitter: how late presses show on each screen (NET=p2p: peer to peer)
node test/predict.mjs                       # a copy against the real match, in every ball and crazy round
BASE=http://localhost:3000 node test/smoke.mjs    # screenshots of every page
node test/physics.mjs 120 6                 # CPU v CPU without drawing: goals, falls, jump heights, hop distances
HOPS=1 node test/physics.mjs 0 8            # each man hopping at the peak of his sway, forward and back
MODS=1 node test/physics.mjs 600 3          # crazy rounds on, a long soak
```

To run them against Redis instead of the memory store, start the site with `REDIS_URL=redis://127.0.0.1:6379`.

`?bot=0.7` only works in builds made with `NEXT_PUBLIC_BOTS=1`. That way nobody can let the CPU play for them in the real cup. The same goes for `?lag=75&jitter=15` on a match page (holds back that page's connection, like a long way round the world), `?delay=0` (overrides the input delay) and, peer to peer, `?net=fair` (prediction off, like the *Equal delay* rule).

## How it is built

- **Next.js 16 (App Router), React 19 and TypeScript.** Every page is a client component that polls `GET /api/t/{code}` every 2 seconds.
- **`lib/engine/`** holds the match engine, which runs on [planck.js](https://piqnt.com/planck.js/) (a Box2D port), 60 ticks a second.
  - **`sim.js`** is the match itself: the pitch, the men, the ball, the rules, the crazy rounds. It never touches a browser, so the match server runs exactly the same code. Each team has two men: the one nearest his own goal is the keeper (darker kit, gloves, number 1), who jumps higher. How far the men sway and how high the keeper jumps are set in `TUNE`.
  - **Dead balls:** a ball lying still is dropped again from the sky after 7 seconds (`TUNE.deadT`). The wait runs at half speed while a man is right next to the ball (`nearRate`), so someone on his way can still save it. A ball stuck on a goal roof waits 2.5 seconds (`roofT`). In the last couple of seconds a gold ring winds down around the ball.
  - **Own goals:** the banner says *Own goal* only when the scoring side hasn't touched the ball in the last 1.5 seconds (`OWN_T`), so a shot that brushes the keeper on its way in still counts as the shooter's goal.
  - **`predict.js`** is a player's copy of the match, running a little ahead of the real one (*Lag*, below).
  - **`game.js`** draws a match and takes the presses. Its modes: `practice` and `local2p` (simulated on this device), `demo` (CPU against CPU), `player` (a player on the match server), `spectator` (draws the server's snapshots: the big screen and the live view), and, peer to peer, `host` and `guest`.
- **`server/`** is the match server: plain Node.js with [ws](https://github.com/websockets/ws), separate from the site so a deploy of the site or a slow page never stalls a match.
  - Each match is a room. It runs the match 60 times a second and sends the two players its full state 20 times a second, and its viewers (the big screen, the live view) small snapshots 30 times a second, about 8 KB/s each. A room takes up to 120 viewers (`MAX_VIEWERS`); the next one is told it's full.
  - A page gets in with a **ticket**: the site signs it (HMAC with `MATCH_SECRET`) for one player of one match, or for a viewer: the organiser (any match, with the admin key) or anyone with the cup's link (only the match on now). It lasts 10 minutes. The match server never reads the database.
  - Kick-offs, goals and results go back to the site's report route, signed with the same secret, retried in order until they're saved. If the match server restarts, the next ticket tells it the saved score, and the match carries on from there.
  - Pages ping once a second. A player silent for 3 seconds (a network that dropped out, which often leaves the connection looking open) is taken as gone, so the match pauses; their page gives up after 3.5 seconds without an answer and comes back by itself.
  - **One match at a time:** the bracket order decides who's on now (the organiser can call another match next), and only the match on now can be played. When calling another match takes the turn from one that hasn't kicked off, that match gets a new generation: the room its players may already be waiting in is dropped, its old tickets can't kick off or report a result, and its pages leave it until it's on again.
- **Lag:** between New Jersey and Buenos Aires a message takes about 150 ms there and back, and no buffer can make that shorter. So each player's page predicts:
  - It runs its own **copy of the match a little ahead** of the server: far enough that a press made now reaches the server before the server gets to that tick. Its own men react at once (after the input delay, below). Each press is stamped with that tick, and the server applies it on exactly that tick, so both matches agree.
  - The server sends each player its **full state** 20 times a second: every body with its speed, each man's timers, and what the physics solver carries from one step to the next. When the copy had the same at that tick, which is most of the time, nothing happens. When the server did something the copy couldn't know (the other player's press, usually), the copy goes back to the server's state and runs the ticks since again. Anything that moved because of that slides into place over about a tenth of a second.
  - **The other player's presses** come from the server the moment it gets them. By the time one arrives the copy is past that tick, so it goes back and runs the ticks since again with it. That man is then drawn from his jump's start and plays 1.4 times as fast until he has caught up, instead of leaping to where he is by now (`CATCH_UP`). Near your own men, or a ball nobody is playing out, he slides into place instead, so whatever you can touch is always drawn where it really is.
  - **Input delay** (a rule on the admin page for matches on the match server, 2 ticks by default, about 33 ms): every press waits that many ticks, and the copy runs that much less ahead, so there is less to correct. A press also carries the lean the player saw, and the server uses it when it's close to its own, so a jump goes where the player aimed it.
  - Measured with the left-hand player 5 ms from the server and the right-hand one 75 ms plus up to 15 ms of jitter (`NEAR=5 node test/lag.mjs 75 15`): your own presses show 43–44 ms after you press (33 ms of that is the input delay), the other player's 120–133 ms, and every jump went in with the lean the player saw.
  - The **line under the pitch** shows the round trip to the server, how much it wobbles, late pictures, catch-ups a minute and this device's frame time.
  - **Peer to peer** (the organiser's switch) works as before the match server: the left-hand player's browser runs the match, streams it over WebRTC (`lib/net/link.js`, signaling through small mailboxes in Redis) and the right-hand player predicts. *Equal delay* switches prediction off there: both players see the match equally late. A free Cloudflare TURN relay (`CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`) helps players whose network blocks direct connections; `/api/ice` says `"relay":true` when it's on.
- **`lib/tournament.ts`** is the knockout bracket, written as pure functions over one JSON document. It covers seeding, byes, the playing order, advancing and organiser corrections.
- **`lib/store.ts`** keeps the cups in Redis (`REDIS_URL`), or Upstash over HTTP, or memory. Updates are compare-and-swap through a small Lua script, so simultaneous results never overwrite each other.
- **API routes:**
  - Create a cup: `POST /api/t`
  - Read the state: `GET /api/t/{code}`
  - Join: `POST /api/t/{code}/join`
  - Organiser actions: `POST /api/t/{code}/admin`
  - A ticket for the match server: `POST /api/t/{code}/m/{id}/ticket` (`{ token }` a player's seat, `{ key }` the organiser watching, `{ watch: true }` anyone watching the match on now)
  - Kick-off, goal and result reports (the match server, or peer to peer the left-hand player): `POST /api/t/{code}/m/{id}/report`
  - Peer to peer only: signaling, `/api/t/{code}/m/{id}/signal`, and relay credentials, `GET /api/ice`

Players are identified by a random token kept in their browser. The server stores only its hash, and the same goes for the admin key.

## Credits

- Flags: [flag-icons](https://github.com/lipis/flag-icons) (MIT, see `public/flags/LICENSE.txt`).
- Fonts: Lilita One and Nunito (SIL Open Font License, see `app/fonts`).
