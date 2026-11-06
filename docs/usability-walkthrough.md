# Fresh-user walkthrough

RSilo is for people who aren't technical, and its tests can't tell whether such a person can actually set it up. This walkthrough can. Run it before announcing a release, and again after any change to deploying, Cloudflare Access or `/account`.

One person is the **tester**: someone non-technical who has never used Cloudflare. One person is the **observer**: you. The observer watches and takes notes. They do not help, and do not explain.

## Before you start

The tester needs:

- A **new** Cloudflare account. An account that has used Zero Trust or R2 before skips the steps most likely to go wrong.
- A GitHub account. The Deploy button copies RSilo into it.
- A laptop browser, plus a second browser or a phone for task 4.

The observer needs a timer and a copy of the log table below. Agree up front that if the tester is stuck for 5 minutes, the observer may give **one** hint, and must write down exactly what the hint was.

## Tasks

Read each task aloud and nothing more. Start the tester on the [README](https://github.com/jonocodes/RSilo#readme).

1. "Get your own RSilo running. Use the free option."
2. "Open your account page and sign in."
3. "Connect [Savr](https://savr.link) to your RSilo, and save something in it."
4. "Open Savr on your other browser or phone, and get the same thing to show up there."
5. "Find what you saved in RSilo's file manager."
6. "Stop Savr from accessing your RSilo."

Any remoteStorage app works in place of Savr. Use the same one every run, so runs can be compared.

## What to watch for

These are the steps that have the most room to go wrong:

- **Deploy button:** connecting GitHub, naming the Worker and its resources, and whether they fill in `OWNER_EMAIL` or skip it.
- **R2:** whether Cloudflare asks for a payment method, and what the tester does when it does.
- **Zero Trust:** picking a team name and the Free plan, and whether it asks for a payment method.
- **The Access application:** entering the Worker's hostname without `https://`, and the path `account`.
- **The Worker-level Access toggle:** whether they turn it on. It locks apps out of `/storage`.
- **Email mismatch:** whether the email in the Access policy and `OWNER_EMAIL` differ. That shows the *Not allowed* page.
- **Storage address:** whether they find it on the dashboard and get it into the app the first time.
- **Pages that explain themselves:** whether the *finish setup* and *Not allowed* pages get them unstuck without the docs.

## Log

Write one row per task, plus a row for every moment of hesitation, wrong turn or hint.

| Task | Minutes | Where they were | What happened | Hint given? |
|------|---------|-----------------|---------------|-------------|
|      |         |                 |               |             |

Afterwards, ask the tester:

- Where were you least sure you were doing the right thing?
- Was there a moment you would have given up if you were alone?
- What do you think Cloudflare Access is for?
- If an app stopped syncing next month, where would you look first?

## After the run

- **Done:** the tester finished all six tasks without a hint. Record the total time.
- File one issue per stall or hint, labelled `needs-triage`. Quote the log row, and link the run's entry below.
- Add a line here for the run.

### Runs

| Date | RSilo version | Tester | Finished unaided? | Total minutes | Issues |
|------|---------------|--------|-------------------|---------------|--------|
