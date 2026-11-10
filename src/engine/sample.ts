// Synthetic sample: a help centre for "Ledgerly", a made-up invoicing app. Every word here is invented
// for this demo. The two runs are simulated: dense-only, and dense + BM25 hybrid (RRF), both over the same
// fixed-size chunks that ignore headings and sentences, so some gold answers get cut in half.
import { chunkText } from './chunks.ts'
import { rng } from './metrics.ts'
import { bm25, rrf, terms } from './text.ts'
import type { Chunk, Dataset, GoldSpan, Qrels, Query, Retrieved, Run, RunRow } from './types.ts'

export const SAMPLE_CHUNK = 128
export const SAMPLE_ID = 'ledgerly'
export const SAMPLE_META = {
  id: SAMPLE_ID,
  name: 'Ledgerly help centre (synthetic)',
  blurb: '60 docs, about 400 fixed-size chunks, 80 labelled queries, dense vs hybrid runs',
}

interface Topic { id: string; name: string; features: string[]; objects: string[]; menus: string[]; docs: string[] }

const TOPICS: Topic[] = [
  { id: 'billing', name: 'Billing and plans', features: ['the plan picker', 'seat billing', 'annual billing', 'the billing portal'], objects: ['subscription', 'seat', 'plan', 'receipt'], menus: ['Settings > Billing', 'Account > Plan'], docs: ['Change your plan', 'Update the card on file', 'Annual vs monthly billing', 'Cancel your subscription', 'Download receipts', 'Seat billing explained'] },
  { id: 'invoices', name: 'Invoices', features: ['the invoice editor', 'recurring invoices', 'invoice reminders', 'invoice templates'], objects: ['invoice', 'line item', 'due date', 'template'], menus: ['Sales > Invoices', 'Settings > Invoice defaults'], docs: ['Create your first invoice', 'Recurring invoices', 'Automatic payment reminders', 'Custom invoice templates', 'Credit notes and voids', 'Invoice numbering'] },
  { id: 'payments', name: 'Payments', features: ['online payments', 'the payment page', 'partial payments', 'payouts'], objects: ['payment', 'payout', 'refund', 'card fee'], menus: ['Sales > Payments', 'Settings > Payment methods'], docs: ['Accept card payments', 'Payout schedule', 'Refund a payment', 'Partial and split payments', 'Failed payments', 'Pass card fees to customers'] },
  { id: 'bank', name: 'Bank feeds', features: ['bank feeds', 'the reconciliation screen', 'bank rules', 'statement import'], objects: ['bank account', 'transaction', 'statement', 'rule'], menus: ['Banking > Accounts', 'Banking > Rules'], docs: ['Connect a bank account', 'Reconcile transactions', 'Bank rules', 'Import a statement file', 'Fix a disconnected feed', 'Duplicate transactions'] },
  { id: 'team', name: 'Team and permissions', features: ['roles', 'team invitations', 'approval flows', 'the audit log'], objects: ['user', 'role', 'invitation', 'approval'], menus: ['Settings > Team', 'Settings > Roles'], docs: ['Invite your team', 'Roles and permissions', 'Expense approvals', 'Remove a user', 'Transfer account ownership', 'Read the audit log'] },
  { id: 'integrations', name: 'Integrations', features: ['the integrations hub', 'the Shopify connector', 'Zapier triggers', 'the payroll sync'], objects: ['integration', 'connector', 'sync', 'webhook'], menus: ['Apps > Integrations', 'Settings > Connected apps'], docs: ['Connect Shopify', 'Zapier triggers and actions', 'Payroll sync', 'CRM contact sync', 'Disconnect an app', 'Integration sync errors'] },
  { id: 'reports', name: 'Reports', features: ['the profit and loss report', 'aged receivables', 'custom reports', 'scheduled exports'], objects: ['report', 'export', 'filter', 'column'], menus: ['Reports > All reports', 'Reports > Scheduled'], docs: ['Profit and loss report', 'Aged receivables', 'Build a custom report', 'Schedule report emails', 'Export to CSV or Excel', 'Cash flow forecast'] },
  { id: 'tax', name: 'Tax', features: ['tax rates', 'the VAT return', 'sales tax tracking', 'tax-inclusive pricing'], objects: ['tax rate', 'return', 'tax code', 'exemption'], menus: ['Settings > Tax', 'Reports > Tax'], docs: ['Set up tax rates', 'File a VAT return', 'US sales tax', 'Tax-inclusive prices', 'Tax exemptions', 'Reverse charge'] },
  { id: 'mobile', name: 'Mobile app', features: ['the mobile app', 'receipt capture', 'offline mode', 'push notifications'], objects: ['receipt', 'photo', 'notification', 'device'], menus: ['the More tab', 'Profile > Notifications'], docs: ['Install the mobile app', 'Capture receipts', 'Offline mode', 'Push notifications', 'Mileage tracking', 'Sign in with a passkey'] },
  { id: 'security', name: 'Security and API', features: ['two-factor authentication', 'API keys', 'single sign-on', 'data exports'], objects: ['API key', 'token', 'session', 'webhook secret'], menus: ['Settings > Security', 'Developers > API keys'], docs: ['Turn on two-factor authentication', 'Create an API key', 'API rate limits', 'Single sign-on (SSO)', 'Webhook signatures', 'Export or delete your data'] },
]

/** [topic, doc index, answer sentence, query, intent, style]. kw = exact-term query (codes, names); para = paraphrased. */
type Fact = [string, number, string, string, string, 'kw' | 'para']
const FACTS: Fact[] = [
  ['billing', 0, 'Plan upgrades take effect immediately and you are charged a prorated amount for the rest of the current billing period.', 'if I upgrade halfway through the month do I pay the full price', 'billing', 'para'],
  ['billing', 0, 'Downgrades are applied at the end of the billing period, so you keep Pro features until the renewal date.', 'when does a downgrade from Pro kick in', 'billing', 'kw'],
  ['billing', 1, 'Error BL-402 means the card issuer declined the charge; ask the bank to allow recurring payments to Ledgerly and retry.', 'BL-402 error on my card', 'troubleshooting', 'kw'],
  ['billing', 2, 'Annual billing costs the same as ten months of monthly billing, which works out to roughly 17 percent off.', 'is it cheaper to pay yearly', 'billing', 'para'],
  ['billing', 3, 'After you cancel, the account stays read-only for 90 days so you can export invoices and reports before deletion.', 'what happens to my data once I stop paying', 'policy', 'para'],
  ['billing', 4, 'Receipts for every charge are listed under Settings > Billing > History and can be downloaded as PDF for the last seven years.', 'where can I get old receipts for my accountant', 'how-to', 'para'],
  ['billing', 5, 'Seats are billed per active user per month, and a user who signs in once during the period counts as active.', 'how are seats counted for billing', 'billing', 'kw'],
  ['billing', 5, 'Accountant and bookkeeper invites on the Partner role are free and never use a paid seat.', 'does my bookkeeper take up a seat', 'billing', 'para'],
  ['invoices', 0, 'A new invoice is saved as a draft until you press Approve, and drafts are never emailed to the customer.', 'will my customer see a draft invoice', 'how-to', 'para'],
  ['invoices', 1, 'Recurring invoices are generated at 06:00 in the organisation time zone on the scheduled day.', 'what time do recurring invoices get created', 'how-to', 'kw'],
  ['invoices', 1, 'If a recurring invoice falls on the 29th, 30th or 31st, shorter months use their last day instead.', 'recurring invoice set for the 31st in February', 'how-to', 'kw'],
  ['invoices', 2, 'Reminders are sent 3 days before the due date and again 7, 14 and 30 days after it unless the invoice is paid.', 'how often does it nudge customers who have not paid', 'how-to', 'para'],
  ['invoices', 2, 'Error INV-221 appears when a reminder is scheduled for a contact without an email address.', 'INV-221 reminder error', 'troubleshooting', 'kw'],
  ['invoices', 3, 'Custom templates accept a logo up to 2 MB in PNG or SVG format and a brand colour in hex.', 'what size logo can I upload for invoices', 'how-to', 'kw'],
  ['invoices', 4, 'A voided invoice keeps its number in the sequence and is marked VOID on the PDF, while a credit note reduces the balance owed.', 'difference between cancelling an invoice and issuing a credit', 'how-to', 'para'],
  ['invoices', 5, 'Invoice numbers can use a prefix of up to 8 characters, and the next number can be changed but never set lower than the highest used.', 'can I restart invoice numbering at 1', 'how-to', 'para'],
  ['invoices', 5, 'Error INV-310 means the number you typed is already taken by another invoice in the same organisation.', 'INV-310 duplicate number', 'troubleshooting', 'kw'],
  ['payments', 0, 'Card payments cost 2.9 percent plus 30 cents per successful charge, with no monthly fee.', 'what fees do you take on card payments', 'billing', 'para'],
  ['payments', 1, 'Payouts arrive on a rolling 2 business day schedule in the US and 3 business days in the UK and EU.', 'how long until money reaches my bank account', 'policy', 'para'],
  ['payments', 1, 'New accounts have a one-time 7 day hold on the first payout while the account is verified.', 'why is my first payout delayed', 'troubleshooting', 'para'],
  ['payments', 2, 'Refunds go back to the original payment method within 5 to 10 business days, and the card fee is not returned.', 'do I get the fee back when I refund', 'policy', 'para'],
  ['payments', 3, 'Partial payments mark the invoice as Partially paid and the remaining balance stays on the reminder schedule.', 'customer only paid half the invoice', 'how-to', 'para'],
  ['payments', 4, 'Error PAY-051 means the customer card needs 3D Secure authentication and the payment page must be reopened.', 'PAY-051', 'troubleshooting', 'kw'],
  ['payments', 4, 'Failed payments are retried automatically on days 1, 3 and 5 for saved cards on recurring invoices.', 'does it retry a declined card automatically', 'troubleshooting', 'para'],
  ['payments', 5, 'Surcharging is not allowed in some US states, so the card fee pass-through option is hidden for addresses there.', 'why can I not add a surcharge in my state', 'policy', 'para'],
  ['bank', 0, 'Bank feeds import up to 90 days of history when you first connect an account.', 'how far back does the bank connection pull transactions', 'how-to', 'para'],
  ['bank', 0, 'Feeds refresh every 4 hours, and you can press Refresh now once per hour.', 'how often do bank transactions update', 'how-to', 'para'],
  ['bank', 1, 'A transaction can be matched to several invoices at once when one deposit pays more than one bill.', 'one deposit covers three invoices', 'how-to', 'para'],
  ['bank', 2, 'Bank rules run in priority order, and the first rule whose conditions match is the only one applied.', 'two bank rules match the same transaction', 'how-to', 'para'],
  ['bank', 3, 'Statement files can be imported in OFX, QFX, QIF or CSV format, up to 5 MB each.', 'can I upload a QIF file', 'how-to', 'kw'],
  ['bank', 4, 'Error BF-17 means the bank requires you to sign in again; feeds pause until the connection is renewed.', 'BF-17 bank feed', 'troubleshooting', 'kw'],
  ['bank', 4, 'Most banks require reauthorisation every 90 days under open banking rules, which is why feeds disconnect.', 'why does my bank keep disconnecting every few months', 'troubleshooting', 'para'],
  ['bank', 5, 'Duplicates usually come from importing a statement file for dates the live feed already covers.', 'same transaction shows up twice', 'troubleshooting', 'para'],
  ['team', 0, 'Invitations expire after 14 days and can be resent from Settings > Team.', 'invite link not working anymore', 'troubleshooting', 'para'],
  ['team', 1, 'The Standard role can create invoices but cannot see bank accounts or payroll unless Banking access is ticked.', 'stop staff from seeing the bank balance', 'how-to', 'para'],
  ['team', 2, 'Expenses above the approval limit go to the approver set for that user, and anything under it is approved automatically.', 'how do expense approval limits work', 'how-to', 'kw'],
  ['team', 3, 'Removing a user keeps everything they created and records their name on past activity in the audit log.', 'if someone leaves do their invoices disappear', 'policy', 'para'],
  ['team', 4, 'Only the current owner can transfer ownership, and the new owner must already have the Admin role.', 'make my business partner the account owner', 'how-to', 'para'],
  ['team', 5, 'The audit log keeps 24 months of history and can be filtered by user, record type or date.', 'how long is the audit log retained', 'policy', 'kw'],
  ['team', 5, 'Error TM-09 means you tried to remove the last Admin; promote someone else first.', 'TM-09 when removing admin', 'troubleshooting', 'kw'],
  ['integrations', 0, 'The Shopify connector imports orders as invoices and payouts as bank deposits every 30 minutes.', 'how often do Shopify orders come across', 'how-to', 'kw'],
  ['integrations', 0, 'Shopify refunds are imported as credit notes linked to the original order invoice.', 'my online store refunds, where do they show up', 'how-to', 'para'],
  ['integrations', 1, 'Zapier triggers fire within 2 minutes of the event and include the full invoice payload.', 'zapier trigger delay', 'how-to', 'kw'],
  ['integrations', 2, 'Payroll sync posts one journal per pay run with wages, taxes and benefits on separate lines.', 'how does salary data come into the books', 'how-to', 'para'],
  ['integrations', 3, 'CRM contact sync is one-way from the CRM, so edits made in Ledgerly are overwritten on the next sync.', 'my contact changes keep getting undone', 'troubleshooting', 'para'],
  ['integrations', 4, 'Disconnecting an app stops future syncs but keeps every record already imported.', 'if I remove an integration do I lose data', 'policy', 'para'],
  ['integrations', 5, 'Error INT-503 is a temporary outage at the connected app; syncs retry every 15 minutes for 24 hours.', 'INT-503 sync failed', 'troubleshooting', 'kw'],
  ['integrations', 5, 'Error INT-401 means the app token was revoked and you need to reconnect it from Apps > Integrations.', 'INT-401', 'troubleshooting', 'kw'],
  ['reports', 0, 'The profit and loss report can be run on a cash or accrual basis using the toggle above the table.', 'show profit on a cash basis', 'how-to', 'kw'],
  ['reports', 1, 'Aged receivables groups unpaid invoices into current, 1 to 30, 31 to 60, 61 to 90 and over 90 days.', 'which customers owe money the longest', 'how-to', 'para'],
  ['reports', 2, 'Custom reports can hold up to 25 columns and 10 filters, and can be saved for the whole team.', 'max columns in a custom report', 'how-to', 'kw'],
  ['reports', 3, 'Scheduled report emails go out at 07:00 on the chosen day and include a PDF and a CSV attachment.', 'send the P&L to my partner every Monday', 'how-to', 'para'],
  ['reports', 4, 'Excel exports are limited to 100,000 rows; larger exports are split into several files in a zip.', 'export is too big for Excel', 'troubleshooting', 'para'],
  ['reports', 5, 'The cash flow forecast projects 13 weeks ahead from open invoices, bills and recurring items.', 'how far ahead does the cash forecast go', 'how-to', 'para'],
  ['tax', 0, 'Each tax rate can combine up to 4 components, such as state, county, city and district.', 'combine state and county tax into one rate', 'how-to', 'para'],
  ['tax', 1, 'VAT returns can be submitted directly to HMRC under Making Tax Digital once the account is connected.', 'submit VAT to HMRC from the app', 'how-to', 'kw'],
  ['tax', 1, 'Error TX-12 means the HMRC connection expired; reconnect it under Settings > Tax before filing.', 'TX-12 HMRC', 'troubleshooting', 'kw'],
  ['tax', 2, 'US sales tax is calculated from the ship-to address, falling back to the business address when none is set.', 'which address is used to work out sales tax', 'how-to', 'para'],
  ['tax', 3, 'Tax-inclusive pricing rounds tax per line item, so totals can differ by a cent from per-invoice rounding.', 'invoice total is off by one cent', 'troubleshooting', 'para'],
  ['tax', 4, 'Exempt customers need a certificate number saved on the contact before the exemption is applied.', 'tax exempt customer still charged tax', 'troubleshooting', 'para'],
  ['tax', 5, 'Reverse charge invoices show zero VAT and print the note required for business customers in another EU country.', 'selling to an EU business, do I charge VAT', 'policy', 'para'],
  ['mobile', 0, 'The mobile app needs iOS 16 or Android 10 or later.', 'minimum android version', 'how-to', 'kw'],
  ['mobile', 1, 'Receipt capture reads the merchant, date and total from a photo and attaches the image to the expense.', 'take a picture of a receipt and have it fill in the expense', 'how-to', 'para'],
  ['mobile', 2, 'Offline mode keeps the last 30 days of invoices on the device and uploads changes when you reconnect.', 'can I make invoices without signal', 'how-to', 'para'],
  ['mobile', 2, 'If the same invoice is edited offline on two devices, the most recent edit wins and the other is saved as a note.', 'edited on phone and laptop offline, which wins', 'troubleshooting', 'para'],
  ['mobile', 3, 'Push notifications for payments received can be turned off per organisation under Profile > Notifications.', 'stop payment alerts on my phone', 'how-to', 'para'],
  ['mobile', 4, 'Mileage is recorded with GPS and uses the 2026 IRS rate of 70 cents per mile unless you set your own.', 'what mileage rate does it use', 'how-to', 'kw'],
  ['mobile', 5, 'Passkeys sign in with Face ID, Touch ID or the device PIN and replace the password on that device.', 'log in with face id', 'how-to', 'kw'],
  ['security', 0, 'Two-factor authentication supports authenticator apps and security keys, but not SMS codes.', 'can I get 2FA codes by text message', 'how-to', 'para'],
  ['security', 0, 'Admins can require two-factor authentication for everyone, and users without it are asked to set it up at next sign-in.', 'force everyone on the team to use 2FA', 'how-to', 'kw'],
  ['security', 1, 'API keys are shown once at creation and can be scoped to read-only or read-write access.', 'I lost my API key, can I see it again', 'how-to', 'para'],
  ['security', 2, 'The API allows 120 requests per minute per key and returns error 429 with a Retry-After header when exceeded.', 'API 429 Retry-After', 'troubleshooting', 'kw'],
  ['security', 3, 'Single sign-on supports SAML 2.0 with Okta, Azure AD and Google Workspace on the Enterprise plan.', 'SAML Okta setup', 'how-to', 'kw'],
  ['security', 4, 'Webhook payloads are signed with HMAC SHA-256 in the Ledgerly-Signature header using your webhook secret.', 'how do I verify a webhook really came from you', 'how-to', 'para'],
  ['security', 5, 'A full data export is a zip of CSV files and attachments, ready to download within 24 hours.', 'get a copy of all my data', 'how-to', 'para'],
]

const VAGUE: [string, string][] = [
  ['it does not work', 'vague'], ['pricing?', 'vague'], ['help with my account', 'vague'], ['numbers look wrong', 'vague'], ['is ledgerly good for restaurants', 'vague'],
]
const UNLABELLED: [string, string, string][] = [
  ['billing', 'change billing email for receipts', 'how-to'], ['invoices', 'add a discount line to an invoice', 'how-to'], ['payments', 'accept ACH bank transfers', 'how-to'],
  ['bank', 'unreconcile a transaction', 'how-to'], ['reports', 'balance sheet comparison by month', 'how-to'], ['tax', 'Canadian GST and PST together', 'how-to'],
  ['mobile', 'app crashes when scanning', 'troubleshooting'], ['security', 'rotate the webhook secret', 'how-to'],
]

// ---------- Filler text ----------

const VERBS = ['review', 'update', 'check', 'set up', 'adjust', 'confirm', 'open', 'edit']
const ADJ = ['current', 'default', 'shared', 'saved', 'selected', 'existing', 'new', 'active']
const ROLES = ['admins', 'owners', 'anyone with edit access', 'team members', 'accountants']
const LINES = [
  (t: Topic, p: (a: string[]) => string) => `You can ${p(VERBS)} the ${p(ADJ)} ${p(t.objects)} from ${p(t.menus)} at any time.`,
  (t: Topic, p: (a: string[]) => string) => `Changes to ${p(t.features)} are saved as soon as you leave the field, and ${p(ROLES)} see them straight away.`,
  (t: Topic, p: (a: string[]) => string) => `Only ${p(ROLES)} can ${p(VERBS)} ${p(t.features)}, so ask one of them if the option is greyed out.`,
  (t: Topic, p: (a: string[]) => string) => `Each ${p(t.objects)} keeps a short history, which helps when you need to see who changed what.`,
  (t: Topic, p: (a: string[]) => string) => `If you work across several organisations, switch to the right one before you ${p(VERBS)} anything here.`,
  (t: Topic, p: (a: string[]) => string) => `Most teams ${p(VERBS)} ${p(t.features)} once a month as part of their close.`,
  (t: Topic, p: (a: string[]) => string) => `The ${p(ADJ)} ${p(t.objects)} appears at the top of the list, with older ones grouped underneath.`,
  (t: Topic, p: (a: string[]) => string) => `Use the search box above the list to find a ${p(t.objects)} by name, number or amount.`,
  (t: Topic, p: (a: string[]) => string) => `Nothing is sent to customers until you confirm, so it is safe to ${p(VERBS)} settings while you explore.`,
  (t: Topic, p: (a: string[]) => string) => `Filters you apply are remembered on this browser, which makes ${p(t.features)} quicker to come back to.`,
  (t: Topic, p: (a: string[]) => string) => `When something looks off, compare the ${p(t.objects)} with the original record before changing it.`,
  (t: Topic, p: (a: string[]) => string) => `The help icon next to ${p(t.features)} opens a short walkthrough for first-time users.`,
]
const STEPS = (t: Topic, p: (a: string[]) => string) => [
  `1. Go to ${p(t.menus)}.`, `2. Select the ${p(t.objects)} you want to work with.`, `3. Choose ${p(['Edit', 'Settings', 'More options', 'Manage'])} in the top right.`,
  `4. ${p(['Update', 'Review', 'Fill in', 'Check'])} the fields and press Save.`, `5. A confirmation appears at the bottom of the screen.`,
]
const FOOTER = 'Still stuck? Contact support from the Help menu in the app and include a screenshot. Our team replies within one business day, Monday to Friday.'

export interface SampleBuild { ds: Dataset; docs: { id: string; title: string; text: string; topic: string }[]; style: Map<string, 'kw' | 'para'> }

let cache: SampleBuild | null = null

export function buildSample(): SampleBuild {
  if (cache) return cache
  const r = rng(2026)
  const p = (a: string[]) => a[Math.floor(r() * a.length)]
  const docs: SampleBuild['docs'] = []
  const spans: GoldSpan[] = []
  const queries: Query[] = []
  const style = new Map<string, 'kw' | 'para'>()
  let qn = 0
  const qid = () => `q${String(++qn).padStart(3, '0')}`

  for (const t of TOPICS) {
    t.docs.forEach((title, di) => {
      const id = `${t.id}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
      const facts = FACTS.filter(f => f[0] === t.id && f[1] === di)
      const filler = (n: number) => Array.from({ length: n }, () => p(LINES)(t, p)).join(' ')
      // Facts are placed at varied depths inside the body so fixed windows cut some of them.
      const sections = [
        `# ${title}`,
        `${title} is part of ${p(t.features)} in Ledgerly. ${filler(5)}`,
        `## Before you start\n${filler(5)}`,
        `## Steps\n${STEPS(t, p).join('\n')}`,
        `## Details\n${filler(5 + Math.floor(r() * 4))}`,
        `## More details\n${filler(6 + Math.floor(r() * 4))}`,
        `## Troubleshooting\n${filler(6 + Math.floor(r() * 4))}`,
        `## Good to know\n${filler(5 + Math.floor(r() * 3))}`,
        `## Limits\n${filler(4)}`,
        FOOTER,
      ]
      const slots = [4, 5, 6, 7, 8]
      facts.forEach((f, i) => {
        const s = slots[(i * 2 + di) % slots.length]
        const parts = sections[s].split('\n')
        const body = parts.at(-1)!.split(/(?<=\.)\s+/)
        body.splice(Math.min(body.length, 1 + Math.floor(r() * body.length)), 0, f[2])
        parts[parts.length - 1] = body.join(' ')
        sections[s] = parts.join('\n')
      })
      const text = sections.join('\n\n')
      docs.push({ id, title, text, topic: t.id })
      for (const f of facts) {
        const start = text.indexOf(f[2].replace(/\.$/, ''))
        const q = qid()
        queries.push({ id: q, text: f[3], intent: f[4], tags: [t.id] })
        spans.push({ queryId: q, docId: id, start, end: start + f[2].replace(/\.$/, '').length })
        style.set(q, f[5])
      }
    })
  }
  // Two stub pages: a moved article and an empty legal page, the kind of tiny orphan chunks real crawls produce.
  docs.push({ id: 'billing/legacy-pricing', title: 'Legacy pricing', text: '# Legacy pricing\n\nThis article moved. See Change your plan.', topic: 'billing' })
  docs.push({ id: 'security/subprocessors', title: 'Subprocessors', text: '# Subprocessors\n\nThe list is available on request.', topic: 'security' })
  // A copy-pasted legacy article: near-duplicate chunks.
  const rem = docs.find(d => d.id === 'invoices/automatic-payment-reminders')!
  docs.push({ id: 'invoices/payment-reminders-legacy', title: 'Payment reminders (legacy)', text: rem.text.replace('# Automatic payment reminders', '# Payment reminders (legacy)'), topic: 'invoices' })

  const corpus: Chunk[] = []
  for (const d of docs) {
    chunkText(d.text, { kind: 'fixed', size: SAMPLE_CHUNK, overlap: 0 }).forEach((rg, i) => {
      corpus.push({ id: `${d.id}#${i}`, docId: d.id, title: d.title, text: d.text.slice(rg.s, rg.e), start: rg.s, end: rg.e })
    })
  }

  for (const [text, intent] of VAGUE) { const q = qid(); queries.push({ id: q, text, intent, tags: ['general'] }); style.set(q, 'para') }
  const labelledIds = queries.map(q => q.id)
  for (const [topic, text, intent] of UNLABELLED) { const q = qid(); queries.push({ id: q, text, intent, tags: [topic] }); style.set(q, 'para') }

  // Graded qrels: the chunk holding the whole answer is 3; halves of a cut answer are 2; the doc's intro chunk is 1.
  const qrels: Qrels = {}
  for (const q of labelledIds) qrels[q] = {}
  for (const s of spans) {
    const inDoc = corpus.filter(c => c.docId === s.docId)
    const over = inDoc.filter(c => Math.min(c.end!, s.end) > Math.max(c.start!, s.start))
    const whole = over.find(c => c.start! <= s.start && c.end! >= s.end)
    if (whole) qrels[s.queryId][whole.id] = 3
    else for (const c of over) qrels[s.queryId][c.id] = 2
    if (!qrels[s.queryId][inDoc[0].id]) qrels[s.queryId][inDoc[0].id] = 1
  }

  const ds: Dataset = { corpus, queries, qrels, spans, runs: [] }
  ds.runs = simulateRuns(ds, docs, style)
  cache = { ds, docs, style }
  return cache
}

// ---------- Simulated retrieval ----------

// A crude "embedding": synonyms collapse to one concept and codes/numbers are invisible, which is roughly
// how dense retrievers behave on exact identifiers.
const SYN: Record<string, string> = {
  pay: 'payment', paying: 'payment', paid: 'payment', price: 'cost', pricing: 'cost', fee: 'cost', fees: 'cost', cheaper: 'cost', charged: 'charge', charges: 'charge',
  yearly: 'annual', year: 'annual', month: 'monthly', money: 'payout', bank: 'bank', deposit: 'payout', staff: 'user', someone: 'user', team: 'user', partner: 'user', bookkeeper: 'accountant',
  picture: 'photo', receipt: 'receipt', phone: 'mobile', signal: 'offline', text: 'sms', message: 'sms', log: 'sign', login: 'sign', data: 'export', copy: 'export', disappear: 'removing', leaves: 'removing',
  remove: 'removing', removing: 'removing', delete: 'removing', stop: 'cancel', nudge: 'reminder', reminders: 'reminder', owe: 'receivables', longest: 'aged', ahead: 'forecast', twice: 'duplicate', undone: 'overwritten',
  books: 'journal', salary: 'payroll', store: 'shopify', online: 'shopify', verify: 'signature', lost: 'shown', see: 'shown', cancelling: 'void', restart: 'number', numbering: 'number', cent: 'rounding',
  exempt: 'exemption', eu: 'reverse', business: 'reverse', far: 'history', back: 'history', update: 'refresh', updates: 'refresh', often: 'every', declined: 'failed', retry: 'retried', half: 'partial', wins: 'recent',
}
const concepts = (text: string) => terms(text).filter(t => !/\d/.test(t)).map(t => SYN[t] ?? t.replace(/(ing|ed|es|s)$/, ''))

function cosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0, na = 0, nb = 0
  for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w) dot += v * w }
  for (const v of b.values()) nb += v * v
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}
const bag = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m }

function simulateRuns(ds: Dataset, docs: SampleBuild['docs'], style: Map<string, 'kw' | 'para'>): Run[] {
  const r = rng(77)
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
  const topicOf = new Map(docs.map(d => [d.id, d.topic]))
  const vecs = ds.corpus.map(c => bag(concepts(c.text)))
  const bm = bm25(ds.corpus)
  const depth = 10
  const rowsA: RunRow[] = [], rowsB: RunRow[] = []

  ds.queries.forEach((q, qi) => {
    const qv = bag(concepts(q.text))
    const qrel = ds.qrels[q.id] ?? {}
    const topic = q.tags?.[0]
    const kw = style.get(q.id) === 'kw'
    const scored = ds.corpus.map((c, i) => {
      const g = qrel[c.id] ?? 0
      let s = 0.3 + (topicOf.get(c.docId) === topic ? 0.12 : 0) + 0.55 * cosine(qv, vecs[i]) + 0.07 * gauss()
      // The embedder understands paraphrases of the answer; exact codes much less so. Cut halves carry less meaning.
      if (g === 3) s += kw ? 0.02 : 0.15
      else if (g === 2) s += kw ? 0 : 0.07
      return { id: c.id, score: Math.round(s * 1e4) / 1e4, g }
    }).sort((a, b) => b.score - a.score)
    const dense = scored.slice(0, depth)
    const hybrid = rrf([dense, bm.search(q.text, depth)], 60, depth)
    const grade = new Map(scored.map(x => [x.id, x.g]))
    // Logged second-stage scores, standing in for a cross-encoder rerank of each candidate list.
    const memo = new Map<string, number>()
    const rerank = (id: string) => memo.get(id) ?? memo.set(id, rerankScore(id)).get(id)!
    const rerankScore = (id: string) => {
      const g = grade.get(id) ?? 0
      const lex = cosine(bag(terms(q.text)), bag(terms(ds.corpus.find(c => c.id === id)!.text)))
      return Math.round(Math.max(0, Math.min(1, (g === 3 ? 0.5 : g === 2 ? 0.3 : g === 1 ? 0.15 : 0.05) + 0.6 * lex + 0.16 * gauss())) * 1e4) / 1e4
    }
    const withRerank = (l: Retrieved[]) => l.map(x => ({ id: x.id, score: x.score, rerank: rerank(x.id) }))
    // The generator cites the best-looking of its top three chunks; every ninth query it just cites the first.
    const cite = (l: Retrieved[]) => qi % 9 === 4 ? [l[0].id] : [l.slice(0, 3).reduce((a, b) => rerank(b.id) > rerank(a.id) ? b : a).id]
    const answer = (l: Retrieved[]) => { const c = ds.corpus.find(x => x.id === cite(l)[0])!; return `According to "${c.title}": ${c.text.replace(/^#.*\n+/, '').split(/(?<=\.)\s/)[0].slice(0, 160)}` }
    rowsA.push({ queryId: q.id, query: q.text, retrieved: withRerank(dense), answer: answer(dense), cited: cite(dense) })
    rowsB.push({ queryId: q.id, query: q.text, retrieved: withRerank(hybrid.map(x => ({ id: x.id, score: Math.round(x.score! * 1e5) / 1e5 }))), answer: answer(hybrid), cited: cite(hybrid) })
  })
  return [
    { id: 'run-dense', name: 'v1 dense only', createdAt: Date.UTC(2026, 9, 6), rows: rowsA, notes: `Synthetic. Dense retriever, top ${depth}, fixed ${SAMPLE_CHUNK}-token chunks, logged rerank scores.` },
    { id: 'run-hybrid', name: 'v2 dense + BM25 (RRF)', createdAt: Date.UTC(2026, 10, 3), rows: rowsB, notes: `Synthetic. Dense + BM25 fused with RRF (k=60), top ${depth}, same chunks.` },
  ]
}
