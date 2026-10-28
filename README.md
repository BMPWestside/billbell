# BillBell — setup

Two parts:

- **Scanner** (`apps-script/`) — runs in your Google account sm466991234@gmail.com. It reads the **Billbell** label every 15 minutes, saves bills to a Google Sheet called **BillBell Data**, and sends phone reminders.
- **App** (the files at the top of this repo) — the BillBell web app, live on GitHub Pages at <https://bmpwestside.github.io/billbell/>.

Do steps 1–3 on a computer. They take about 10 minutes.

## 1. Add the scanner to Google

1. Sign in to Google as **sm466991234@gmail.com**, then open <https://script.google.com> and click **New project**. Name it **BillBell**.
2. Delete everything in `Code.gs`, then paste in the contents of `apps-script/Code.gs`.
3. Click **+** next to Files, choose **Script**, and name it **Parser**. Paste in the contents of `apps-script/Parser.gs`.
4. On the left, click **Services +**, choose **Drive API**, and click **Add**. Drive API is what lets the scanner read PDF bills.
5. Pick **setup** in the function list at the top, then click **Run**.
   - When Google asks for permission, click **Review permissions**, choose your account, then **Advanced** and **Go to BillBell**, then **Allow**.
   - `setup` creates the sheet, the bills folder and the timers, and reads your past bills from the label.

## 2. Turn on the app connection

1. Click **Deploy**, then **New deployment**. Click the gear icon and choose **Web app**.
   - Set **Execute as** to **Me**.
   - Set **Who has access** to **Anyone**. Your data stays protected by your private app key.
   - Click **Deploy**. You don't need to copy the URL.
2. Pick **sendSetupLink** in the function list and click **Run**.
3. You'll get an email called **BillBell setup link** that contains:
   - A one-tap link that connects the app on your iPhone.
   - Your reminder topic for the **ntfy** app.

Keep that email private.

## 3. Turn on phone reminders

1. Install the free **ntfy** app from the App Store.
2. Tap **+** and subscribe to the topic from the email. The topic looks like `billbell-xxxxxxxxxxxx`.

## 4. Add BillBell to your iPhone

The app is already live on GitHub Pages.

Then, on your iPhone:

1. Open the setup link from the email in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.

## How it works

- **Header**: unpaid bills, the total to pay, and a spending ring comparing this month with last month. Tap the ring for Stats.
- **Bills / Paid / Review tabs**:
  - **Bills** has a "Next" line for the next bill, a 2-week calendar (tap **Month** for the full month), and one logo tile per provider.
  - Tile dots: **red** due in 3 days or less or overdue, **orange** to pay, **blue** auto-debit, **green** paid.
  - Tap a tile for the amount, due date, BPAY details with copy buttons, and **Pay**, **Bill** and **Mark paid** buttons. Swipe a bill left to mark it paid, with Undo.
  - **Review** holds anything BillBell isn't sure about. Fix the details and tap **Confirm**, or tap **Not a bill**. A red dot on the tab means something is waiting.
- **Paid automatically when** a payment receipt arrives (AGL), a bill already says it's paid (amaysim), or a later bill shows the earlier one was credited (Optus "$84.29 CR").
- **Alerts**: "hasn't arrived" for regular bills that are late, ▲ when a bill is 20% or more above usual, and duplicates are skipped.
- **Reminders on ntfy at 8am**: 2 days before a bill is due, on the due date, every 3 days while overdue, when a bill goes missing, and when bills wait in Review. New bills alert as they arrive.
- **Bottom bar**:
  - **Stats**: last 12 months, a single month, or the Australian tax year (Jul–Jun), by category and provider, with a trend line and CSV export.
  - **Add**: take a photo or pick a PDF and BillBell reads it into Review, or type a bill in.
  - **Settings**: connection, reminders, theme, app lock, providers and export.
- **Refresh**: pull down anywhere.
- **Themes**: Navy & Gold, Teal & Aqua, Plum & Rose, Forest & Sand, Graphite & Coral. Pick yours before **Add to Home Screen** so the icon matches.
- **App lock**: a 4-digit PIN, plus Face ID once the PIN is set.
- **Offline**: once opened, BillBell starts instantly and shows your last bills without signal.
- **Logos**: setup downloads each provider's icon from its own website into the Providers tab. Run `refreshLogos` after adding a provider, or paste your own image link into the `logo` cell.
- **Dark mode** follows your iPhone's setting.

## Changing providers or categories

Open the **Providers** tab in the **BillBell Data** sheet.

- `match` is the text that identifies each provider's emails.
- `category` controls which chart group the provider's spending goes into.
- `domain` is the provider's website, used for its logo.
- `cycle` is how many days usually pass between bills. It's used for the "hasn't arrived" alert. Set it to `0` for irregular bills such as Supagas.

To add a new provider, add a row in the same format.
