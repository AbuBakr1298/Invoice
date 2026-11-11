/*! QuickInvoice invoice generator. Everything runs in your browser; invoice data is never uploaded. */
(function () {
    'use strict';

    /* ---------- Helpers ---------- */
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const isSafeImgSrc = (v) => /^(https?:\/\/|data:image\/)/i.test(v);
    // Hidden logo/QR images keep a 1x1 transparent pixel instead of an empty src: an <img> without a source makes
    // the PDF library log an unhandled "Event" rejection when it clones the invoice.
    const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const icon = (name, cls) => '<svg class="i' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false"><use href="#i-' + name + '"/></svg>';
    const pad = (n) => String(n).padStart(2, '0');
    // Local calendar date as YYYY-MM-DD. (input.valueAsDate uses UTC, which gives yesterday's date for users ahead of UTC.)
    const toLocalISO = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    // Round half up while ignoring binary floating-point noise (e.g. 1.005 * 100 = 100.49999999999999).
    const roundHalfUp = (x) => (Number.isFinite(x) ? Math.round(Number(x.toPrecision(15))) : 0);
    const toCents = (n) => roundHalfUp(n * 100);
    const clampPct = (v) => Math.min(100, Math.max(0, parseFloat(v) || 0));
    const prettyDate = (iso) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
        if (!m) return '';
        return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    };

    /* ---------- PDF library: loaded on demand, not on every page view ---------- */
    // Self-hosted copy of html2pdf.js (official v0.10.1 build): no third-party request is made to create a PDF.
    const THIS_SCRIPT = document.currentScript && document.currentScript.src;
    const HTML2PDF_SRC = THIS_SCRIPT
        ? new URL('../vendor/html2pdf-0.10.1/html2pdf.bundle.min.js', THIS_SCRIPT).href
        : 'assets/vendor/html2pdf-0.10.1/html2pdf.bundle.min.js';
    let html2pdfPromise = null;
    function loadHtml2Pdf() {
        if (window.html2pdf) return Promise.resolve(window.html2pdf);
        if (!html2pdfPromise) {
            html2pdfPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = HTML2PDF_SRC;
                s.async = true;
                s.referrerPolicy = 'no-referrer';
                s.onload = () => (window.html2pdf ? resolve(window.html2pdf) : reject(new Error('html2pdf missing')));
                s.onerror = () => { html2pdfPromise = null; reject(new Error('Could not load the PDF library')); };
                document.head.appendChild(s);
            });
        }
        return html2pdfPromise;
    }
    const warmUpPdf = () => { loadHtml2Pdf().catch(() => {}); };

    /* ---------- Dialog helpers (payment email draft) ---------- */
    const emailModal = $('emailModal');
    let lastFocus = null;
    const focusableIn = (root) => Array.from(root.querySelectorAll('a[href], button:not([disabled]), textarea, input:not([readonly]), select')).filter((el) => el.offsetParent !== null);
    function openModal(m) {
        lastFocus = document.activeElement;
        m.classList.remove('hidden');
        const f = focusableIn(m)[0];
        if (f) f.focus();
    }
    function closeModal(m) {
        m.classList.add('hidden');
        if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    emailModal.addEventListener('click', (e) => {
        if (e.target === emailModal || e.target.closest('[data-close]')) closeModal(emailModal);
    });
    document.addEventListener('keydown', (e) => {
        if (emailModal.classList.contains('hidden')) return;
        if (e.key === 'Escape') { closeModal(emailModal); return; }
        if (e.key === 'Tab') {
            const items = focusableIn(emailModal);
            if (!items.length) return;
            const first = items[0], last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });

    /* ---------- Mobile tabs ---------- */
    const tabEditBtn = $('tabEditBtn'), tabPreviewBtn = $('tabPreviewBtn');
    const formSection = $('formSection'), previewSection = $('previewSection');
    const ACTIVE = 'flex-1 py-3 text-xs font-bold text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50/50 flex items-center justify-center gap-2 transition';
    const IDLE = 'flex-1 py-3 text-xs font-bold text-slate-500 border-b-2 border-transparent flex items-center justify-center gap-2 transition';
    tabEditBtn.addEventListener('click', () => {
        formSection.classList.remove('hidden');
        previewSection.classList.add('hidden');
        tabEditBtn.className = ACTIVE; tabPreviewBtn.className = IDLE;
        tabEditBtn.setAttribute('aria-selected', 'true');
        tabPreviewBtn.setAttribute('aria-selected', 'false');
    });
    tabPreviewBtn.addEventListener('click', () => {
        formSection.classList.add('hidden');
        previewSection.classList.remove('hidden');
        previewSection.classList.add('flex');
        tabPreviewBtn.className = ACTIVE; tabEditBtn.className = IDLE;
        tabPreviewBtn.setAttribute('aria-selected', 'true');
        tabEditBtn.setAttribute('aria-selected', 'false');
    });
    window.addEventListener('resize', () => {
        if (window.innerWidth >= 1024) { formSection.classList.remove('hidden'); previewSection.classList.remove('hidden'); previewSection.classList.add('flex'); }
    });

    /* ---------- Defaults ---------- */
    const today = new Date();
    $('issueDate').value = toLocalISO(today);
    const due = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14);
    $('dueDate').value = toLocalISO(due);

    const currencySelect = $('currencySelect');
    const itemsContainer = $('itemsContainer');
    const sellerLogoUrl = $('sellerLogoUrl');
    const universalLogoBox = $('universalLogoBox');

    const inputs = {};
    ['sellerName', 'sellerEmail', 'sellerPhone', 'sellerAddress', 'clientName', 'clientEmail', 'clientPhone', 'clientAddress',
     'invoiceNumber', 'issueDate', 'dueDate', 'taxRate', 'discountRate', 'bankName', 'accountNumber', 'qrCodeUrl', 'invoiceNotes']
        .forEach((k) => { inputs[k] = $(k); });
    const sellerLogoFile = $('sellerLogoFile');

    const previews = {
        sellerName: $('previewSellerName'),
        logoImg: $('previewLogoImg'),
        sellerEmail: $('previewSellerEmail'),
        sellerPhone: $('previewSellerPhone'),
        sellerAddress: $('previewSellerAddress'),
        clientName: $('previewClientName'), clientEmail: $('previewClientEmail'), clientPhone: $('previewClientPhone'), clientAddress: $('previewClientAddress'),
        invoiceNumber: $('previewInvoiceNumber'), issueDate: $('previewIssueDate'), dueDate: $('previewDueDate'),
        taxRate: $('previewTaxRate'), discountRate: $('previewDiscountRate'),
        bankName: $('previewBankName'), accountNumber: $('previewAccountNumber'), qrImg: $('previewQrImg'), notes: $('previewNotes'),
        itemsTable: $('previewItemsTable'), subtotal: $('previewSubtotal'), taxAmount: $('previewTaxAmount'),
        discountAmount: $('previewDiscountAmount'), grandTotal: $('previewGrandTotal')
    };

    /* ---------- Logo handling ---------- */
    let uploadedLogoDataUrl = '';
    function processLogoFile(file) {
        if (!file || !/^image\//.test(file.type)) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            uploadedLogoDataUrl = ev.target.result;
            sellerLogoUrl.value = file.name;
            calculateInvoice();
        };
        reader.readAsDataURL(file);
    }
    document.addEventListener('paste', (e) => {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                const file = items[i].getAsFile();
                if (file) { processLogoFile(file); e.preventDefault(); }
            }
        }
    });
    sellerLogoFile.addEventListener('change', (e) => { if (e.target.files[0]) processLogoFile(e.target.files[0]); });
    ['dragenter', 'dragover'].forEach((n) => universalLogoBox.addEventListener(n, (e) => {
        e.preventDefault(); e.stopPropagation();
        universalLogoBox.classList.add('border-indigo-500', 'ring-2', 'ring-indigo-500');
    }));
    ['dragleave', 'drop'].forEach((n) => universalLogoBox.addEventListener(n, (e) => {
        e.preventDefault(); e.stopPropagation();
        universalLogoBox.classList.remove('border-indigo-500', 'ring-2', 'ring-indigo-500');
    }));
    universalLogoBox.addEventListener('drop', (e) => {
        const file = e.dataTransfer && e.dataTransfer.files[0];
        if (file) processLogoFile(file);
    });
    sellerLogoUrl.addEventListener('input', () => {
        const val = sellerLogoUrl.value.trim();
        if (/^https?:\/\//i.test(val)) { uploadedLogoDataUrl = ''; sellerLogoFile.value = ''; }
        calculateInvoice();
    });

    /* ---------- Items ---------- */
    let rowCounter = 0;
    function createItemRow(desc, qty, rate) {
        rowCounter++;
        const n = rowCounter;
        const row = document.createElement('div');
        row.className = 'item-row grid grid-cols-12 gap-2 items-center bg-slate-50 p-3 rounded-xl border border-slate-200';
        row.innerHTML = `
            <div class="col-span-12 sm:col-span-5">
                <label for="itemDesc${n}" class="block text-[10px] uppercase font-semibold text-slate-500 mb-1">Description</label>
                <input type="text" id="itemDesc${n}" name="itemDesc${n}" class="item-desc w-full px-2.5 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500" placeholder="e.g. Web Design Services">
            </div>
            <div class="col-span-4 sm:col-span-2">
                <label for="itemQty${n}" class="block text-[10px] uppercase font-semibold text-slate-500 mb-1">Qty</label>
                <input type="number" id="itemQty${n}" name="itemQty${n}" min="0" step="any" inputmode="decimal" class="item-qty w-full px-2.5 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500">
            </div>
            <div class="col-span-6 sm:col-span-3">
                <label for="itemRate${n}" class="block text-[10px] uppercase font-semibold text-slate-500 mb-1">Rate</label>
                <input type="number" id="itemRate${n}" name="itemRate${n}" min="0" step="0.01" inputmode="decimal" class="item-rate w-full px-2.5 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500" placeholder="0.00">
            </div>
            <div class="col-span-2 flex items-center justify-between sm:pt-5">
                <span class="item-total text-sm font-semibold text-slate-700" aria-label="Line total">$0.00</span>
                <button type="button" aria-label="Remove item" class="remove-item text-slate-400 hover:text-red-500 p-2 transition">${icon('trash', 'text-sm')}</button>
            </div>`;
        row.querySelector('.item-desc').value = desc || '';
        row.querySelector('.item-qty').value = qty != null ? qty : 1;
        row.querySelector('.item-rate').value = rate != null ? rate : 0;
        row.querySelectorAll('input').forEach((i) => i.addEventListener('input', calculateInvoice));
        row.querySelector('.remove-item').addEventListener('click', () => {
            if (itemsContainer.querySelectorAll('.item-row').length > 1) {
                row.remove();
                calculateInvoice();
            }
        });
        return row;
    }
    itemsContainer.appendChild(createItemRow('', 1, 0));
    $('addItemBtn').addEventListener('click', () => {
        const row = createItemRow('', 1, 0);
        itemsContainer.appendChild(row);
        calculateInvoice();
        row.querySelector('.item-desc').focus();
    });

    /* ---------- Calculation + preview ----------
       Order: line totals -> subtotal -> discount -> taxable amount -> tax -> total.
       Every amount is rounded to the cent so the printed figures add up exactly. */
    function getCurrencySymbol() {
        const o = currencySelect.options[currencySelect.selectedIndex];
        return o.getAttribute('data-symbol') || '$';
    }
    function calculateInvoice() {
        const symbol = getCurrencySymbol();
        const money = (c) => (c < 0 ? '-' : '') + symbol + (Math.abs(c) / 100).toFixed(2);
        let subtotalC = 0;
        let html = '';
        itemsContainer.querySelectorAll('.item-row').forEach((row) => {
            const desc = row.querySelector('.item-desc').value.trim();
            const qty = parseFloat(row.querySelector('.item-qty').value) || 0;
            const rate = parseFloat(row.querySelector('.item-rate').value) || 0;
            const lineC = toCents(qty * rate);
            subtotalC += lineC;
            row.querySelector('.item-total').textContent = money(lineC);
            html += `<tr class="border-b border-slate-100">
                <td class="py-2.5 px-1 font-medium text-slate-800">${esc(desc) || '-'}</td>
                <td class="py-2.5 px-1 text-center text-slate-600">${esc(qty)}</td>
                <td class="py-2.5 px-1 text-right text-slate-600">${esc(symbol)}${rate.toFixed(2)}</td>
                <td class="py-2.5 px-1 text-right font-semibold text-slate-800">${esc(money(lineC))}</td>
            </tr>`;
        });
        previews.itemsTable.innerHTML = html;

        const taxRate = clampPct(inputs.taxRate.value);
        const discountRate = clampPct(inputs.discountRate.value);
        const discountC = roundHalfUp(subtotalC * discountRate / 100);
        const taxableC = subtotalC - discountC;
        const taxC = roundHalfUp(taxableC * taxRate / 100);
        const totalC = Math.max(0, taxableC + taxC);

        previews.sellerName.textContent = inputs.sellerName.value.trim() || 'Your Business Name';
        previews.sellerEmail.textContent = inputs.sellerEmail.value.trim() || 'email@example.com';
        previews.sellerPhone.textContent = inputs.sellerPhone.value.trim() || '+1 000 000 0000';
        previews.sellerAddress.textContent = inputs.sellerAddress.value.trim() || 'Your Business Address';

        const logoInputVal = sellerLogoUrl.value.trim();
        const src = uploadedLogoDataUrl || (isSafeImgSrc(logoInputVal) ? logoInputVal : '');
        if (src) {
            previews.logoImg.src = src;
            previews.logoImg.style.display = 'block';
        } else {
            previews.logoImg.src = BLANK_IMG;
            previews.logoImg.style.display = 'none';
        }

        previews.clientName.textContent = inputs.clientName.value.trim() || 'Client Name';
        previews.clientEmail.textContent = inputs.clientEmail.value.trim() || 'client@example.com';
        previews.clientPhone.textContent = inputs.clientPhone.value.trim() || '+1 000 000 0000';
        previews.clientAddress.textContent = inputs.clientAddress.value.trim() || 'Client Address';
        previews.invoiceNumber.textContent = inputs.invoiceNumber.value.trim() || 'INV-0001';
        previews.issueDate.textContent = inputs.issueDate.value || '-';
        previews.dueDate.textContent = inputs.dueDate.value || '-';
        previews.taxRate.textContent = taxRate;
        previews.discountRate.textContent = discountRate;
        previews.bankName.textContent = inputs.bankName.value.trim() || '-';
        previews.accountNumber.textContent = inputs.accountNumber.value.trim() || '-';

        const qrUrl = inputs.qrCodeUrl.value.trim();
        if (qrUrl && isSafeImgSrc(qrUrl)) { previews.qrImg.src = qrUrl; previews.qrImg.style.display = 'block'; }
        else { previews.qrImg.src = BLANK_IMG; previews.qrImg.style.display = 'none'; }

        previews.notes.textContent = inputs.invoiceNotes.value.trim() || 'Thank you for your business!';
        previews.subtotal.textContent = money(subtotalC);
        previews.discountAmount.textContent = '-' + money(discountC);
        previews.taxAmount.textContent = money(taxC);
        previews.grandTotal.textContent = money(totalC);
    }
    Object.keys(inputs).forEach((k) => inputs[k].addEventListener('input', calculateInvoice));
    currencySelect.addEventListener('change', calculateInvoice);

    /* ---------- Actions ---------- */
    // Start fetching the PDF library as soon as the visitor engages with the form or the PDF button.
    formSection.addEventListener('input', warmUpPdf, { once: true });
    const pdfBtn = $('downloadPdfBtn');
    ['pointerenter', 'focus', 'touchstart'].forEach((ev) => pdfBtn.addEventListener(ev, warmUpPdf, { once: true, passive: true }));

    pdfBtn.addEventListener('click', async () => {
        const label = pdfBtn.querySelector('span');
        const original = label.textContent;
        pdfBtn.disabled = true;
        label.textContent = 'Preparing...';
        try {
            const lib = await loadHtml2Pdf();
            const safeName = (inputs.invoiceNumber.value.trim() || 'Invoice').replace(/[^\w\-. ]+/g, '_');
            await lib().from($('invoice-preview')).set({
                margin: 10,
                filename: safeName + '.pdf',
                image: { type: 'jpeg', quality: 0.98 },
                // scrollX/scrollY: 0 matters. The library renders a copy of the invoice in a position:fixed overlay, so the
                // page's own scroll offset must not be applied; with the default, the PDF is cropped or blank whenever the
                // visitor has scrolled down before pressing PDF (which is the normal case: the form is long).
                html2canvas: { scale: 2, useCORS: true, scrollX: 0, scrollY: 0, logging: false },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            }).save();
        } catch (err) {
            alert('The PDF library could not be loaded. Check your internet connection and try again, or use Print and choose "Save as PDF".');
        } finally {
            pdfBtn.disabled = false;
            label.textContent = original;
        }
    });

    $('printBtn').addEventListener('click', () => window.print());

    $('whatsappBtn').addEventListener('click', () => {
        const due = prettyDate(inputs.dueDate.value);
        const msg = `Hello *${inputs.clientName.value.trim() || 'Client'}*,\n\nHere is your invoice *#${inputs.invoiceNumber.value.trim() || 'INV-0001'}*.\nTotal Amount Due: *${previews.grandTotal.textContent}* (${currencySelect.value})\n` +
            (due ? `Due Date: ${due}\n` : '') + `\nThank you for your business! Please review and confirm payment.`;
        window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank', 'noopener');
    });

    /* ---------- Payment email draft (plain template, nothing is sent anywhere) ---------- */
    const emailSubject = $('emailSubject'), emailBody = $('emailBody'), emailMailto = $('emailMailto'), emailCopyBtn = $('emailCopyBtn');
    function updateMailto() {
        const to = inputs.clientEmail.value.trim();
        emailMailto.href = 'mailto:' + encodeURIComponent(to).replace(/%40/g, '@') +
            '?subject=' + encodeURIComponent(emailSubject.value) +
            '&body=' + encodeURIComponent(emailBody.value.replace(/\r?\n/g, '\r\n'));
    }
    function buildEmailDraft() {
        const client = inputs.clientName.value.trim();
        const seller = inputs.sellerName.value.trim() || 'Your name';
        const number = inputs.invoiceNumber.value.trim() || 'INV-0001';
        const due = prettyDate(inputs.dueDate.value);
        const total = previews.grandTotal.textContent;
        emailSubject.value = `Invoice #${number} from ${seller}`;
        emailBody.value = (client ? `Dear ${client},` : 'Hello,') +
            `\n\nPlease find attached invoice #${number} for ${total}` + (due ? `, due on ${due}.` : '.') +
            `\n\nPayment details are included on the invoice. If you have any questions, just reply to this email.` +
            `\n\nThank you for your business.\n\nBest regards,\n${seller}`;
        updateMailto();
    }
    $('emailDraftBtn').addEventListener('click', () => { buildEmailDraft(); openModal(emailModal); });
    emailBody.addEventListener('input', updateMailto);
    emailCopyBtn.addEventListener('click', async () => {
        const label = emailCopyBtn.querySelector('span');
        const original = label.textContent;
        try {
            await navigator.clipboard.writeText(emailBody.value);
            label.textContent = 'Copied!';
        } catch (err) {
            emailBody.focus(); emailBody.select();
            label.textContent = 'Press Ctrl+C to copy';
        }
        setTimeout(() => { label.textContent = original; }, 2200);
    });

    calculateInvoice();
})();
