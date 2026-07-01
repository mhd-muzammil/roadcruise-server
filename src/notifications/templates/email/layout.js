/**
 * Shared responsive, branded email layout. Email templates supply a `title`
 * and `content` (inner HTML) and wrap it with `emailLayout(...)`.
 *
 * Inline styles only (email-client safe). Mobile-responsive via max-width.
 * NOTE: placeholders ({{...}}) inside `content` are filled by the engine AFTER
 * wrapping, so the whole document is a single template string.
 */
export const emailLayout = ({ title, content, preheader = "" }) => `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <tr>
        <td style="background:linear-gradient(135deg,#0f0f12,#1c1c22);padding:28px 32px;">
          <span style="font-size:20px;font-weight:700;letter-spacing:0.5px;color:#d4af37;">{{companyName}}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:32px;">
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#18181b;">${title}</h1>
          ${content}
        </td>
      </tr>
      <tr>
        <td style="padding:24px 32px;background:#fafafa;border-top:1px solid #eee;font-size:12px;color:#71717a;">
          <p style="margin:0 0 4px;">Need help? Call {{supportPhone}} or email {{supportEmail}}.</p>
          <p style="margin:0;color:#a1a1aa;">© {{companyName}}. This is an automated message.</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

/** A reusable key/value detail block for trip/booking/payment summaries. */
export const detailRow = (label, value) => `
<tr>
  <td style="padding:8px 0;font-size:13px;color:#71717a;">${label}</td>
  <td style="padding:8px 0;font-size:13px;font-weight:600;color:#18181b;text-align:right;">${value}</td>
</tr>`;

export const detailTable = (rows) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-top:1px solid #eee;">
  ${rows}
</table>`;

export default emailLayout;
