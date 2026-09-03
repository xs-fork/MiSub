function normalizeRecipients(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(/[,;\n]/);
    return values.map(item => String(item || '').trim()).filter(Boolean);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export async function sendEmailNotification(emailConfig, { subject, text, html } = {}) {
    const config = emailConfig && typeof emailConfig === 'object' ? emailConfig : {};
    if (config.enabled !== true) return { sent: false, skipped: true, reason: 'disabled' };

    const smtpHost = String(config.smtpHost || '').trim();
    const smtpUser = String(config.smtpUser || '').trim();
    const smtpPassword = String(config.smtpPassword || '');
    const from = String(config.from || '').trim();
    const recipients = normalizeRecipients(config.to);
    if (!smtpHost || !smtpUser || !smtpPassword || !from || recipients.length === 0) {
        return { sent: false, skipped: true, reason: 'incomplete_config' };
    }

    const plainText = String(text || '').trim();
    const htmlContent = String(html || '').trim() || `<p>${escapeHtml(plainText).replace(/\n/g, '<br>')}</p>`;

    try {
        const nodemailer = (await import('nodemailer')).default;
        const transporter = nodemailer.createTransport({
            host: smtpHost,
            port: Number(config.smtpPort) || 465,
            secure: config.smtpSecure !== false,
            auth: { user: smtpUser, pass: smtpPassword }
        });
        await transporter.sendMail({ from, to: recipients, subject: String(subject || 'MiSub notification'), text: plainText, html: htmlContent });
        return { sent: true };
    } catch (error) {
        console.warn('[EmailNotification] Failed to send SMTP email:', error?.message || error);
        return { sent: false, reason: 'smtp_error' };
    }
}

export function buildSubscriptionFailureEmail({ name, url, error, errorType } = {}) {
    const safeName = String(name || '未命名订阅');
    const safeUrl = String(url || '');
    const safeError = String(error || '未知错误');
    const safeType = String(errorType || 'unknown');
    const text = [
        'MiSub 机场订阅更新失败',
        `订阅名称: ${safeName}`,
        `订阅地址: ${safeUrl}`,
        `失败类型: ${safeType}`,
        `失败提示: ${safeError}`,
        `发生时间: ${new Date().toISOString()}`
    ].join('\n');

    return {
        subject: `[MiSub] 订阅更新失败: ${safeName}`,
        text,
        html: `<h2>MiSub 机场订阅更新失败</h2><p><strong>订阅名称：</strong>${escapeHtml(safeName)}</p><p><strong>订阅地址：</strong><code>${escapeHtml(safeUrl)}</code></p><p><strong>失败类型：</strong>${escapeHtml(safeType)}</p><p><strong>失败提示：</strong>${escapeHtml(safeError)}</p><p><strong>发生时间：</strong>${escapeHtml(new Date().toISOString())}</p>`
    };
}

export function buildSubscriptionAlertEmail({ type, name, url, status, detail } = {}) {
    const labels = {
        expiry: '订阅即将到期提醒',
        traffic: '订阅流量提醒'
    };
    const title = labels[type] || 'MiSub 订阅提醒';
    const safeName = String(name || '未命名订阅');
    const safeUrl = String(url || '');
    const safeStatus = String(status || '');
    const safeDetail = String(detail || '');
    const text = [
        `MiSub ${title}`,
        `订阅名称: ${safeName}`,
        `订阅地址: ${safeUrl}`,
        `状态: ${safeStatus}`,
        `详情: ${safeDetail}`,
        `发生时间: ${new Date().toISOString()}`
    ].join('\n');

    return {
        subject: `[MiSub] ${title}: ${safeName}`,
        text,
        html: `<h2>MiSub ${escapeHtml(title)}</h2><p><strong>订阅名称：</strong>${escapeHtml(safeName)}</p><p><strong>订阅地址：</strong><code>${escapeHtml(safeUrl)}</code></p><p><strong>状态：</strong>${escapeHtml(safeStatus)}</p><p><strong>详情：</strong>${escapeHtml(safeDetail)}</p><p><strong>发生时间：</strong>${escapeHtml(new Date().toISOString())}</p>`
    };
}
