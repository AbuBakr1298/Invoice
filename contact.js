/*! QuickInvoice contact form. Sends name, email, subject and message through FormSubmit to the support inbox. */
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const form = $('contactForm');
    if (!form) return;

    const TO = form.getAttribute('data-email');
    const WA = form.getAttribute('data-whatsapp');
    const alertBox = $('contactAlert');
    const submitBtn = $('contactSubmitBtn');
    const icon = (name, cls) => '<svg class="i' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false"><use href="#i-' + name + '"/></svg>';
    const SEND_LABEL = icon('paper-plane') + ' Send Email';
    const OK = 'p-3 rounded-lg text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200';
    const WARN = 'p-3 rounded-lg text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200';
    let hideTimer = null;

    function show(cls, text) {
        alertBox.className = cls;
        alertBox.textContent = text;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => alertBox.classList.add('hidden'), 8000);
    }
    const val = (id) => $(id).value.trim();

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!form.checkValidity()) { form.reportValidity(); return; }
        const name = val('contactName');
        const email = val('contactEmail');
        const subject = val('contactSubject') || 'Inquiry regarding QuickInvoice';
        const message = val('contactMessage');
        submitBtn.disabled = true;
        submitBtn.innerHTML = icon('spinner', 'animate-spin') + ' Sending...';

        fetch('https://formsubmit.co/ajax/' + TO, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ name: name, email: email, _subject: 'QuickInvoice Contact: ' + subject, message: message })
        }).then((r) => {
            if (!r.ok) throw new Error('Request failed');
            return r.json();
        }).then((d) => {
            // FormSubmit answers 200 with success:"false" when a form is not yet activated, so check the body too.
            if (!d || !(d.success === true || d.success === 'true')) throw new Error('Not delivered');
            show(OK, 'Thank you ' + name + '! Your message has been sent.');
            form.reset();
        }).catch(() => {
            show(WARN, 'We could not send that automatically, so your email app is opening with your message instead.');
            window.location.href = 'mailto:' + TO + '?subject=' + encodeURIComponent(subject) +
                '&body=' + encodeURIComponent('Name: ' + name + '\nEmail: ' + email + '\n\nMessage:\n' + message);
        }).finally(() => {
            submitBtn.disabled = false;
            submitBtn.innerHTML = SEND_LABEL;
        });
    });

    $('contactWhatsAppBtn').addEventListener('click', () => {
        const name = val('contactName') || 'User';
        const email = val('contactEmail') || 'N/A';
        const subject = val('contactSubject') || 'QuickInvoice Inquiry';
        const message = val('contactMessage') || 'Hello, I need assistance with QuickInvoice.';
        const text = `*New Contact Message from QuickInvoice*\n\n*Name:* ${name}\n*Email:* ${email}\n*Subject:* ${subject}\n\n*Message:*\n${message}`;
        window.open('https://wa.me/' + WA + '?text=' + encodeURIComponent(text), '_blank', 'noopener');
    });
})();
