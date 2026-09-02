# What this server keeps

*Last updated 2026-09-02. The page served at `/privacy` on every deployment carries this text with the operator's name filled in.*

**Your Hevy API key.** Stored encrypted in Cloudflare. Only your connected app can unlock it, and only while a request is on its way to Hevy. It is never logged and never stored in the clear.

**Your name and connection details.** Your Hevy display name, one-way fingerprints of your account and key, the date you connected, and the app you used. That is how the person running the server sees who is connected, and how you reconnect later.

**Not your workouts.** Nothing from your training log is stored here; requests go to Hevy and back. One exception: your exercise list is cached for six hours so the server doesn't ask Hevy for it on every search.

## How long

One year from the day you connect, however often you use it. Your app refreshes its short-term access every seven days in the background; that doesn't extend the year. After a year the connection and the encrypted key are deleted and your assistant asks for the key again. Disconnecting an app removes that connection sooner; "disconnect from Hevy everywhere" deletes everything. Reconnecting an app adds a new connection and leaves the older one until it expires or you disconnect it; ask your assistant to list your connections to see them.

## Who can read it

The person running this server could technically read your key while it is in use. Nobody else can read the stored copy. It is a personal project with no support promise, and Hevy's developer access is unofficial: Hevy may change or remove it.

## Leaving

- **Tell your assistant "disconnect from Hevy".** Removes that app's connection; other apps you connected keep working. Say "disconnect from Hevy everywhere" to remove every app, delete the stored key, and forget it.
- **Or revoke the key on [Hevy's Developer page](https://hevy.com/settings?developer).** It stops working everywhere at once; this server drops its copy the next time an app tries to use it.
- Removing the connection inside Claude does not delete the stored key.
