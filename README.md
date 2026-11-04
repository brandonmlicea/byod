# BYOD

Bring your own domain. Own your agent mailboxes.

BYOD gives Claude Code (or any MCP client) email addresses on a domain you own: `signup@yourname.xyz`, `invoices@yourname.xyz`, as many as you like. Agents create them, read what arrives with the codes and links already picked out, wait for a verification email, save attachments, and reply or send with files from your computer.

The mail lands in a Cloudflare Worker in your own Cloudflare account and is stored there, in a Durable Object only you can reach. The MCP server runs on your machine. There is no account to sign up for, and nothing passes through anyone else.

## What you need

- A domain. A `.xyz` on [Spaceship](https://www.spaceship.com) is usually a dollar or two for the first year (check the renewal price).
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account. Receiving mail works on the free plan. Sending to any address needs Cloudflare's Workers Paid plan ($5 a month).
- Node.js 20 or newer.

## Set it up

### 1. Buy a domain on Spaceship

Search for a name on spaceship.com, sort by price, buy the cheapest one you like. Any name works; it only has to be yours.

### 2. Move its DNS to Cloudflare

1. In Cloudflare, **Add a domain**, type it in, pick the **Free** plan and continue. Cloudflare shows two nameservers, like `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`.
2. In Spaceship, open **Advanced DNS** and pick the domain. Under **Nameservers**, click **Change**, choose **Custom nameservers** and confirm, paste Cloudflare's two in place of Spaceship's, and **Save**. This ends Spaceship's own email forwarding or hosting on that domain, which is what you want.
3. Wait for Cloudflare to say the domain is **Active**. It is often minutes, at most 48 hours.

### 3. Deploy your Worker

```sh
npx -y github:brandonmlicea/byod setup yourname.xyz
```

It signs you in to Cloudflare with Wrangler the first time, deploys the `byod` Worker to your account, sets a random secret token on it, and saves the Worker's address and token to `~/.byod/config.json` (readable only by you). Give several domains to use them all: `setup yourname.xyz other.dev`. Run it again any time to update; the token stays the same.

### 4. Two switches in the Cloudflare dashboard

For each domain:

1. **Receive:** Compute > Email Service > **Email Routing** > Onboard Domain. Then **Routing rules** > **Catch-all address** > Edit > action **Send to a Worker** > `byod` > Save, and make sure the catch-all is on.
2. **Send** (Workers Paid): Compute > Email Service > **Email Sending** > Onboard Domain. Cloudflare adds the SPF, DKIM and DMARC records itself.

### 5. Add it to Claude Code

```sh
claude mcp add byod -- npx -y github:brandonmlicea/byod
```

Any other MCP client (Claude Desktop, Cursor, Codex...):

```json
{
  "mcpServers": {
    "byod": { "command": "npx", "args": ["-y", "github:brandonmlicea/byod"] }
  }
}
```

To point it somewhere else, set `BYOD_URL` and `BYOD_TOKEN` instead of the config file.

## Tools

| Tool | What it does |
| --- | --- |
| `mailbox_list` | Your domains and mailboxes, how many messages each holds and the newest id |
| `mailbox_create` | A mailbox on your domain: a name, or a random one; `hours` makes it expire |
| `mailbox_read` | Messages with sender, subject, codes, links, files and text; `after` skips what you saw, `wait` holds up to 25 s for the next one |
| `mailbox_send` | Send from one of your mailboxes, with cc, bcc and files from your computer; `reply_to` a message id threads the reply |
| `mailbox_sent` | The last 50 emails sent from a mailbox |
| `mailbox_save` | Save a received attachment to your computer (Downloads by default) |
| `mailbox_delete` | Delete a mailbox and everything in it |

## Try it

- "Make me a mailbox for signing up to Figma, sign up with it, and paste me the confirmation code."
- "Create invoices@ and tell me when something arrives there."
- "Reply to the last email in support@ saying we'll ship Friday, and attach ~/Desktop/quote.pdf."

## How it behaves

- Mail to an address that is not a mailbox is refused, so the catch-all never collects spam. `name+anything@` goes to `name@`.
- Mail always leaves from one of your mailboxes; nothing an agent passes can set another From.
- The API answers only to your token, compared in constant time.
- Each mailbox keeps its last 1,000 messages. Inbound mail is capped at 10 MB.
- Sending: 50 recipients an email, 10 files and about 3.5 MB of attachments, and 100 emails a day by default (`DAILY_LIMIT` in `worker/wrangler.jsonc`), so a runaway agent cannot burn your domain's reputation.
- Expired mailboxes are deleted with their mail the next time the Worker is used.

## Check it

```sh
npm install
npm test        # the code and link picker on labelled cases
npm run e2e     # the Worker in wrangler dev and the MCP server, end to end
```

`npm run e2e` runs everything on your machine: it sends real MIME messages into a local Worker, reads them, waits for one, saves an attachment, replies and deletes, through the MCP server.

## Remove it

Delete the `byod` Worker in Cloudflare (Workers & Pages), which deletes its mail, and `~/.byod`.

## License

MIT
