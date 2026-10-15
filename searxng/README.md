# Web search for Offline AI (SearXNG)

This folder is the search backend for the **🌐 Web** button in the customer's
chat window. Offline AI itself never leaves the customer's computer; only the
question they typed goes out, and only when they switch the button on.

```
customer's chat page  ->  your licence server  ->  SearXNG  ->  Google/Bing/...
   (their PC)                (Render or a VPS)      (this folder)
```

SearXNG is free and open source. There is no search API bill.

---

## 1. Run it

```bash
cd searxng
docker compose up -d
```

Check it:

```bash
curl -s "http://127.0.0.1:8080/search?q=capital+of+france&format=json" | head -c 300
```

You should get JSON back. If you get HTML, `search.formats` in `settings.yml`
did not pick up `json`.

## 2. Point the licence server at it

If the licence server runs **on the same machine** (recommended - simplest and
nothing is exposed to the internet):

```
SEARXNG_URL=http://127.0.0.1:8080
```

If the licence server is on **Render or another host** and SearXNG is on a VPS,
you must not open port 8080 to the world: the bot limiter is off and JSON is
on, so anyone who finds it can use your instance as a free search proxy. Put
the token proxy in front of it:

1. Edit `Caddyfile`: your domain, and a long random token.
2. `docker compose --profile exposed up -d`
3. On the licence server:
   ```
   SEARXNG_URL=https://search.yourdomain.com
   SEARXNG_TOKEN=<the same long random token>
   ```

Test that the gate actually works before you trust it:

```bash
curl -i "https://search.yourdomain.com/search?q=test&format=json"              # expect 403
curl -i -H "Authorization: Bearer <token>" "https://search.yourdomain.com/search?q=capital+of+france&format=json" | head -c 200
```

## 3. Tell the server to offer it to customers

```
WEBSEARCH_ENABLED=true            # the master switch
WEBSEARCH_TRIAL_ENABLED=false     # true if you want trial users to have it too
WEBSEARCH_QUOTA_MONTHLY=300       # searches per customer per month (0 = unlimited)
```

`/admin` shows `web search: via <url>` when it is wired up, and
`web search: NOT CONFIGURED` when it is not. Customers with search switched off
simply do not see the button.

---

## Why the config looks like this

An engine list matters more than it looks. Measured here against real questions:

| engine | result |
|---|---|
| `google_cse` | correct and current, every time |
| `bing` | "capital of France" returned **"Bet9ja Agents: sports betting software"** |
| `duckduckgo` | CAPTCHA |
| `brave` | "Suspended: too many requests" |
| `qwant`, `mojeek` | access denied, or keyword-matched nonsense |

So `settings.yml` keeps SearXNG's **default** engine set - which is what
includes `google_cse` - and only disables the scrapers that CAPTCHA on sight.
An earlier version here used a `keep_only` list copied from another project,
and that list quietly excluded `google_cse`, leaving only the broken scrapers.
The result was a model confidently answering from junk. **Do not bring back
`keep_only`.** Disable individual engines instead, so nothing good disappears
by accident.

`google_cse` is keyless: it queries Google's Custom Search endpoint with a
public id. If it ever stops working, check
`docker exec -it offlineai-searxng cat /etc/searxng/settings.yml` and compare
against this folder, then look at `/var/log/searxng` inside the container.

## Free instances are not an option

Every public SearXNG instance tested refused `format=json` - HTML, bot
challenges, or "Too Many Requests". Most switch the JSON API off deliberately.
Self-hosting is required, which is exactly why this folder exists.

## Cost and load

One search is one HTTP request to SearXNG — that part is milliseconds, and
free. The cost lands on the customer's CPU, because the model has to process
every result before it writes a word. Measured A/B on the target laptop:

| | to the first word |
|---|---|
| question alone | 4.5s |
| same question plus 4 results | **15.9s** |

So budget roughly **11–14 seconds added** per search at the current defaults
(4 results, 320-character snippets). `WEBSEARCH_RESULTS` and
`WEBSEARCH_SNIPPET_CHARS` set the dial. The licence server caches identical
questions for 30 minutes and does not count a cached answer against the
customer's quota, and the chat window shows the sources the moment they arrive
so the wait is visible.
