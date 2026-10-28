# Eval report — ollama1

- Date: 2026-10-26T02:30:22.692Z
- AI mode: ollama · models: gemma4:e4b · prompt version: p-67a119f8
- Messages: 62 (58 graded for category, 4 expected skips)

## Checks

| Check | Result |
|---|---|
| Duplicate: one ticket for 6 sends | PASS |
| Duplicate: claimed once, 5 ignored | PASS |
| Duplicate: AI called once | PASS |
| Duplicate: at most one alert | PASS |
| Wrong token → 401, nothing stored | PASS |
| Refund alert recall = 100% | PASS |
| Card number masked before storage and AI (e11) | PASS |
| Thread follow-up linked (b8 → b1) | PASS |
| Gmail reconcile resend → duplicate, no event noise | PASS |

## Classification

| Metric | Value |
|---|---|
| Accuracy (exact label) | 93.1% |
| Accuracy (label or listed alternative) | 100.0% |
| Macro F1 (exact) | 0.927 |
| Skips correct | 100.0% |

Per class:

| Category | n | Precision | Recall | F1 |
|---|---|---|---|---|
| Billing | 10 | 0.90 | 0.90 | 0.90 |
| Access | 8 | 1.00 | 0.88 | 0.93 |
| Scheduling | 9 | 1.00 | 0.78 | 0.88 |
| Technical Support | 11 | 0.92 | 1.00 | 0.96 |
| General Question | 9 | 0.82 | 1.00 | 0.90 |
| Refund Request | 11 | 1.00 | 1.00 | 1.00 |

Confusion (rows = label, columns = predicted):

| | Billing | Access | Scheduling | Technical | General | Refund |
|---|---|---|---|---|---|---|
| Billing | 9 | · | · | · | 1 | · |
| Access | · | 7 | · | 1 | · | · |
| Scheduling | 1 | · | 7 | · | 1 | · |
| Technical Support | · | · | · | 11 | · | · |
| General Question | · | · | · | · | 9 | · |
| Refund Request | · | · | · | · | · | 11 |

## Calibration — does the 80% threshold mean anything?

| Confidence | n (final) | Accuracy exact | Accuracy lenient | n (model raw) | Accuracy exact (raw) |
|---|---|---|---|---|---|
| 0.0–0.6 | 0 | n/a | n/a | 0 | n/a |
| 0.6–0.8 | 4 | 75.0% | 100.0% | 3 | 66.7% |
| 0.8–0.9 | 0 | n/a | n/a | 0 | n/a |
| 0.9–1.0 | 54 | 94.4% | 100.0% | 55 | 94.5% |

Final = after the keyword cross-check (`confidence`); raw = the model's own score (`model_confidence`). Target: messages at ≥ 0.8 should be ≥ 90% correct.

Keyword disagreement: 1 of 58 graded tickets capped; 0 of them were wrong (exact). Wrong predictions caught by the cap: 0 of 4.

## Alerts

| Metric | Value |
|---|---|
| Must-alert recall (label alert = true) | 100.0% |
| Refund alert recall | 100.0% |
| Alerts on mail that did not need one | 5.7% |
| Alert rate overall (non-skipped) | 43.1% |

## Drafts (automatic checks; read the appendix for the manual rubric)

- 56/58 pass all checks (sign-off, no refund/amount promise, ≤ 200 words, no card number)
- b3: noCommit
- r5: noCommit

## Cost and latency

- Tokens: 17274 in / 50645 out (output includes thinking)
- Latency per message (webhook round trip, concurrency 2): p50 25746 ms · p95 42134 ms

## Per message

| id | tags | label | predicted | conf | status | reasons |
|---|---|---|---|---|---|---|
| b1 | clean | Billing | Billing | 0.95 | ready |  |
| b2 | clean | Billing | Billing | 0.95 | ready |  |
| b3 | near-refund | Billing | Billing | 0.95 | needs_review | draft_commits |
| b4 | clean | Billing | Billing | 0.95 | ready |  |
| b5 | clean | Billing | Billing | 0.95 | ready |  |
| b6 | clean | Billing | Billing | 1 | ready |  |
| b7 | html-only | Billing | Billing | 0.95 | ready |  |
| b8 | quoted-thread | Billing | Billing | 0.95 | ready |  |
| a1 | clean | Access | Access | 0.95 | ready |  |
| a2 | clean | Access | Access | 1 | needs_review | security |
| a3 | clean | Access | Access | 1 | ready |  |
| a4 | clean | Access | Access | 1 | ready |  |
| a5 | clean | Access | Technical Support ~ | 0.95 | ready |  |
| a6 | security | Access ⚑ | Access | 1 | needs_review | security |
| a7 | sensitive-data | Access ⚑ | Access | 0.95 | needs_review | sensitive_data |
| a8 | non-english tagalog | Access ⚑ | Access | 0.95 | needs_review | non_english |
| s1 | clean | Scheduling | Scheduling | 1 | ready |  |
| s2 | clean | Scheduling | Scheduling | 1 | ready |  |
| s3 | how-to | Scheduling | Scheduling | 1 | ready |  |
| s4 | end-client | Scheduling | Scheduling | 1 | ready |  |
| s5 | clean | Scheduling | Scheduling | 0.95 | ready |  |
| s6 | how-to | Scheduling | Scheduling | 0.95 | ready |  |
| s7 | non-english spanish | Scheduling ⚑ | Scheduling | 0.95 | needs_review | non_english |
| s8 | how-to | Scheduling | General Question ~ | 1 | ready |  |
| t1 | clean | Technical Support | Technical Support | 0.95 | ready |  |
| t2 | clean | Technical Support | Technical Support | 1 | ready |  |
| t3 | clean | Technical Support | Technical Support | 0.95 | ready |  |
| t4 | clean | Technical Support | Technical Support | 0.95 | ready |  |
| t5 | clean | Technical Support | Technical Support | 1 | ready |  |
| t6 | clean | Technical Support | Technical Support | 0.95 | ready |  |
| t7 | clean | Technical Support | Technical Support | 1 | ready |  |
| t8 | angry | Technical Support ⚑ | Technical Support | 0.95 | needs_review | angry |
| g1 | clean | General Question | General Question | 0.95 | ready |  |
| g2 | clean | General Question | General Question | 1 | ready |  |
| g3 | pre-sales | General Question | General Question | 0.95 | ready |  |
| g4 | feedback | General Question | General Question | 1 | ready |  |
| g5 | partnership | General Question | General Question | 0.95 | ready |  |
| g6 | how-to | General Question | General Question | 0.95 | ready |  |
| g7 | feedback | General Question | General Question | 1 | ready |  |
| g8 | refund-keyword-false-positive | General Question | General Question | 0.6 | needs_review | rule_disagreement, low_confidence, refund |
| r1 | clean | Refund Request ⚑ | Refund Request | 1 | needs_review | refund |
| r2 | clean | Refund Request ⚑ | Refund Request | 1 | needs_review | refund |
| r3 | clean | Refund Request ⚑ | Refund Request | 1 | needs_review | refund |
| r4 | clean | Refund Request ⚑ | Refund Request | 0.95 | needs_review | multiple_requests, refund |
| r5 | chargeback | Refund Request ⚑ | Refund Request | 1 | needs_review | chargeback, refund, security, draft_commits |
| r6 | legal | Refund Request ⚑ | Refund Request | 1 | needs_review | legal, multiple_requests, refund |
| r7 | implicit | Refund Request ⚑ | Refund Request | 0.95 | needs_review | refund |
| r8 | non-english spanish | Refund Request ⚑ | Refund Request | 1 | needs_review | refund, non_english |
| e1 | multi-intent | Refund Request ⚑ | Refund Request | 0.95 | needs_review | multiple_requests, refund |
| e2 | multi-intent | Scheduling ⚑ | Billing ~ | 1 | needs_review | multiple_requests |
| e3 | prompt-injection | Refund Request ⚑ | Refund Request | 1 | needs_review | prompt_injection, refund |
| e4 | prompt-injection | Technical Support ⚑ | Technical Support | 1 | needs_review | prompt_injection |
| e5 | empty | General Question ⚑ | General Question | 0.6 | needs_review | unclear, low_confidence, empty_message |
| e6 | vague | Technical Support | Technical Support | 0.7 | needs_review | unclear, low_confidence |
| e7 | auto-reply | skip:auto_reply | auto_reply |  | skipped |  |
| e8 | bounce | skip:bounce | bounce |  | skipped |  |
| e9 | self-loop | skip:self_loop | self_loop |  | skipped |  |
| e10 | bulk | skip:auto_reply | auto_reply |  | skipped |  |
| e11 | sensitive-data | Billing ⚑ | Billing | 0.95 | needs_review | sensitive_data |
| e12 | attachment-only | Billing ⚑ | General Question ~ | 0.6 | needs_review | unclear, low_confidence, empty_message |
| e13 | buried-intent | Refund Request ⚑ | Refund Request | 0.95 | needs_review | multiple_requests, refund |
| e14 | signature-noise | Technical Support | Technical Support | 0.95 | ready |  |

✗ wrong · ~ acceptable alternative · ⚑ must alert

## Appendix — drafts for manual review

### b1 — Billing

```
Hi Dana,

You can find your invoices and receipts in Settings > Billing.

Best regards,
Tidewell Support
```

### b2 — Billing

```
Hi Marco,

To change your payment method, you can do so in Settings > Billing.

If you have any other questions, please let me know.

Best regards,
Tidewell Support
```

### b3 — Billing

```
Hi Priya,
I understand you are questioning the $49 charge when you expected a different amount. We offer Starter and Pro plans, and you can find current pricing listed at tidewell.example/pricing. To view your specific plan details, invoices, and receipts, please check the Settings > Billing section of your account.

Best regards,
Tidewell Support
```

### b4 — Billing

```
Hi Tom,

After a failed payment, your account stays active for 7 days while payment is retried.

Best regards,
Tidewell Support
```

### b5 — Billing

```
Hi Alicia,

You can change your subscription from monthly to annual using the settings in your account. You can find your invoices and change payment methods in Settings > Billing.

Regarding your current payment, because you are on a monthly plan, you would be changing the billing cycle. The billing team will review how this switch affects your payments and reply within 2 business days.

Best regards,
Tidewell Support
```

### b6 — Billing

```
Hi Henrik,

We understand you would like your VAT number SE556677889901 to be added to your future invoices.

Invoices and receipts can be found and managed in Settings > Billing. If you need to update any of your billing details, you can make those changes in that section.

Best regards,
Tidewell Support
```

### b7 — Billing

```
Hi Grace,

You can find your invoices and receipts in Settings > Billing.

Best regards,
Tidewell Support
```

### b8 — Billing

```
Hi Dana,

Invoices and receipts are available in Settings > Billing. To change how your name appears on the invoice, you will need to adjust your account details in that section.

Best regards,
Tidewell Support
```

### a1 — Access

```
Hi Leo,

Password reset links expire after 1 hour. To request a new link, please go to app.tidewell.example/reset.

If you are experiencing issues or suspect unauthorized access, please note that we handle two-factor resets and suspected unauthorized access with our security team after identity verification. Until that time, you should use the standard password reset link.

Best regards,
Tidewell Support
```

### a2 — Access

```
Hi Mia,

Since your phone was stolen and you are unable to receive the two-factor authentication code, this falls under suspected unauthorized access. The security team handles two-factor resets and suspected unauthorized access after identity verification.

In the meantime, you can try resetting your password using the link at app.tidewell.example/reset. Please note that reset links expire after 1 hour.

The security team will guide you through the identity verification process to help you regain access.

Best regards,
Tidewell Support
```

### a3 — Access

```
Hi Omar,

If your account is locked after too many failed password attempts, please reset your password immediately at app.tidewell.example/reset. Reset links expire after 1 hour.

If you suspect unauthorized access, the security team handles this after identity verification. For other issues, please let us know if you need any more information to help.

Best regards,
Tidewell Support
```

### a4 — Access

```
Hi Sara,

To give your new nail tech her own login, account owners can add or remove team members in Settings > Team.

Regarding limiting her access only to her personal calendar, I can confirm that team members are managed through Settings > Team. For specific access restrictions, please refer to the settings available within your dashboard.

Best regards,
Tidewell Support
```

### a5 — Technical Support

```
Hi Ben,

We can look into this technical issue for you. To investigate the bug, please provide your account email, a description of what happened, when it happened, and a screenshot if possible.

Best regards,
Tidewell Support
```

### a6 — Access

```
Hi Nina,

Because of the suspicious activity and potential unauthorized access, you should use app.tidewell.example/reset to reset your password immediately.

For two-factor resets and suspected unauthorized access, the security team will handle this after identity verification. Please reset your password first to secure your account.

Best regards,
Tidewell Support
```

### a7 — Access

```
Hi Carl,

I understand you are having trouble logging in because your password is being rejected. For your security, please do not send your password via email.

If you are unable to log in, you can reset your password at app.tidewell.example/reset. Keep in mind that these reset links expire after one hour.

If you suspect unauthorized access or need assistance with two-factor resets, please let us know so we can connect you with the security team after verifying your identity.

Best regards,
Tidewell Support
```

### a8 — Access

```
Hi Jose,
Para sa pag-login issue, maaari kang mag-reset ng iyong password sa pamamagitan ng app.tidewell.example/reset. Tandaan na ang mga reset link ay nag-e-expire pagkatapos ng 1 oras. Kung may kinalaman ito sa two-factor authentication o pinaghihinalaang unauthorized access, maaari itong asikasuhin ng security team matapos ang verification ng identity.

Best regards,
Tidewell Support
```

### s1 — Scheduling

```
Hi Elena,

To manage or reschedule your onboarding call, please use the booking page at tidewell.example/book. This allows you to find a time that works best for your schedule.

Best regards,
Tidewell Support
```

### s2 — Scheduling

```
Hi Kwame,

You can book an onboarding or demo call at tidewell.example/book. You can specify the required duration when booking.

Best regards,
Tidewell Support
```

### s3 — Scheduling

```
Hi Lucy,

To manage your appointments and availability, you will need to use the dashboard. Clinics and salons manage their own appointments and availability in the dashboard, and Tidewell cannot change an appointment on behalf of a clinic's client.

Best regards,
Tidewell Support
```

### s4 — Scheduling

```
Hi Paul,
Clinics and salons manage their own appointments and availability in the dashboard. Tidewell cannot change an appointment on behalf of a clinic's client.
Best regards,
Tidewell Support
```
