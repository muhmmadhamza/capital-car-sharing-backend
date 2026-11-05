const config = require('../config/env');

let transporter;

const isConfigured = () => !!config.smtp.host;

function getTransporter() {
  if (transporter) return transporter;
  // Loaded lazily so the API still starts (and logs a clear message) if SMTP is not set up yet.
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Where each role's "choose a new password" page lives in the Next.js app.
const RESET_PATHS = {
  customer: '/reset-password',
  partner: '/partner/reset-password',
  admin: '/admin/reset-password',
};

const buildResetLink = (role, token) => `${config.frontendUrl}${RESET_PATHS[role]}?token=${encodeURIComponent(token)}`;

/**
 * Sends the password-reset email. Resolves true only when the SMTP server accepted the message;
 * resolves false (never throws, never logs the link or token) when email is not configured or fails.
 * "Accepted by the SMTP server" is not proof of inbox delivery.
 */
async function sendPasswordResetEmail({ to, name, role, token }) {
  if (!isConfigured()) {
    console.warn('Password reset email NOT sent: SMTP_HOST is not configured.');
    return false;
  }
  const link = buildResetLink(role, token);
  const minutes = config.passwordReset.ttlMinutes;
  const safeName = escapeHtml(name || 'there');
  try {
    await getTransporter().sendMail({
      from: config.smtp.from,
      to,
      subject: 'Reset your Capital Car Sharing password',
      text:
        `Hi ${name || 'there'},\n\n` +
        `We received a request to reset your Capital Car Sharing ${role} account password.\n` +
        `Choose a new password here (valid for ${minutes} minutes, one use only):\n\n${link}\n\n` +
        `If you did not ask for this, you can ignore this email - your password will not change.\n`,
      html:
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#0B1F3A">` +
        `<h2 style="margin:0 0 16px">Reset your password</h2>` +
        `<p>Hi ${safeName},</p>` +
        `<p>We received a request to reset your Capital Car Sharing ${escapeHtml(role)} account password. ` +
        `This link is valid for ${minutes} minutes and can be used once.</p>` +
        `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#0B1F3A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Choose a new password</a></p>` +
        `<p style="font-size:13px;color:#555">If you did not ask for this, you can ignore this email - your password will not change.</p>` +
        `</div>`,
    });
    return true;
  } catch (err) {
    console.error('Password reset email failed:', err.code || err.name, err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Identity verification notices. Same rules as the password reset email: resolves true only when the SMTP
// server accepted the message, false (never throws) when email is not configured or sending fails, and nothing
// personal (no document data, no address) is ever logged. "Accepted" is not proof of inbox delivery.
const VERIFICATION_COPY = {
  received: {
    subject: 'We received your verification documents',
    lead: 'Thank you. We have received your identity verification and our team will review it shortly. We will email you as soon as there is a decision.',
  },
  approved: {
    subject: 'Your identity has been verified',
    lead: 'Good news: your identity verification is approved. You can now reserve cars on Capital Car Sharing.',
  },
  rejected: {
    subject: 'Your identity verification was not approved',
    lead: 'We could not approve your identity verification.',
  },
  resubmission_required: {
    subject: 'Action needed: please resubmit your verification',
    lead: 'We need a little more from you before we can approve your identity verification.',
  },
};

async function sendVerificationEmail({ to, name, kind, reason }) {
  const copy = VERIFICATION_COPY[kind];
  if (!copy) return false;
  if (!isConfigured()) {
    console.warn(`Verification email (${kind}) NOT sent: SMTP_HOST is not configured.`);
    return false;
  }
  const link = `${config.frontendUrl}/customer/verification`;
  const cta = kind === 'rejected' || kind === 'resubmission_required' ? 'Review and resubmit' : 'Open verification';
  const reasonText = reason ? `\nReason from our team: ${reason}\n` : '';
  const reasonHtml = reason
    ? `<p style="background:#F4F6FA;border-left:4px solid #C9A227;padding:10px 14px"><strong>Reason from our team:</strong><br>${escapeHtml(reason)}</p>`
    : '';
  try {
    await getTransporter().sendMail({
      from: config.smtp.from,
      to,
      subject: copy.subject,
      text: `Hi ${name || 'there'},\n\n${copy.lead}\n${reasonText}\n${link}\n`,
      html:
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#0B1F3A">` +
        `<h2 style="margin:0 0 16px">${escapeHtml(copy.subject)}</h2>` +
        `<p>Hi ${escapeHtml(name || 'there')},</p><p>${escapeHtml(copy.lead)}</p>${reasonHtml}` +
        `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#0B1F3A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${cta}</a></p>` +
        `</div>`,
    });
    return true;
  } catch (err) {
    console.error(`Verification email (${kind}) failed:`, err.code || err.name);
    return false;
  }
}

module.exports = { sendPasswordResetEmail, sendVerificationEmail, buildResetLink, isConfigured };

