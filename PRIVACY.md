# What this server keeps

*Last updated 2026-09-01. The page served at `/privacy` on every deployment carries this text with the operator's name filled in.*

**Your Hevy API key.** This server stores an encrypted copy in Cloudflare. Your connected app holds what is needed to unlock it, so the stored copy cannot be read on its own. The server unlocks the key only while sending your request to Hevy. It never stores an unencrypted copy or writes the key to logs.

**Your Hevy display name and connection details.** In addition to the encrypted key above, this server stores one-way fingerprints of your Hevy account and key, the dates you connected, and the app you used: Claude, ChatGPT, Claude Code, or Cursor. This lets the person running the server see who is connected and lets you reconnect later.

**Your workouts stay in Hevy.** This server does not store workout, routine, or measurement data. It does keep an unencrypted copy of your exercise list (Hevy's built-in exercises and any custom ones) for six hours, so it does not have to ask Hevy for the same list repeatedly.

## How long

Your connection lasts for one year from the day you connect, no matter how often you use it. Your app renews its short-term access every seven days in the background, but that does not extend the one-year limit. After one year, the connection and encrypted key are deleted, and your assistant asks you to paste the key again. Your Hevy key will still be on Hevy's Developer page unless you revoked it. Your display name, account and key fingerprints, and connection dates are also kept for up to one year. Disconnecting deletes them sooner.

## Who can read it

The person running this server could technically read your key while the server is using it. Nobody else can read the stored copy. This is a personal project with no support promise. Hevy's developer access is unofficial, and Hevy says it may change or remove it.

## Leaving

- **Tell your assistant "disconnect from Hevy".** This disconnects every app using this server, deletes the stored key, and forgets the key you used.
- **Or revoke the key on [Hevy's Developer page](https://hevy.com/settings?developer).** It stops working immediately everywhere it was used, including this server. This server deletes its stored copy the next time an app tries to use it.
- Removing the connection from Claude does not delete the stored key. Use one of the options above.
