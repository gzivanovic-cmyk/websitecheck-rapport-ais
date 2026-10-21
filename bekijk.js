/* Website-checks: opent één versleuteld rapport. De link is /r/<id>/#<sleutel>; de sleutel staat na het #-teken
   en gaat dus nooit naar de server. Zonder precies die link is data.json niet te lezen (AES-256-GCM). */
(async function () {
  function melding(kop, tekst) {
    document.body.innerHTML = '<main style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:14vh auto;padding:0 16px;line-height:1.55;color:#0B1020">'
      + '<h1 style="font-size:24px;margin:0 0 8px">' + kop + '</h1><p>' + tekst + '</p></main>';
  }
  function bytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    s += '==='.slice((s.length + 3) % 4);
    return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
  }
  var d;
  try {
    var r = await fetch('data.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    d = await r.json();
  } catch (e) {
    return melding('Deze link werkt niet (meer)', 'Vraag gerust een nieuwe websitecheck aan.');
  }
  if (d.verloopt && new Date(d.verloopt + 'T23:59:59') < new Date()) {
    return melding('Deze websitecheck is verlopen', d.verlopen_tekst || 'Vraag gerust een nieuwe websitecheck aan.');
  }
  var sleutel = location.hash.slice(1);
  if (!sleutel) return melding('Deze link is niet compleet', 'Open de link precies zoals je hem kreeg, met alles na het #-teken.');
  try {
    var key = await crypto.subtle.importKey('raw', bytes(sleutel), 'AES-GCM', false, ['decrypt']);
    var ct = bytes(d.ct), tag = bytes(d.tag), samen = new Uint8Array(ct.length + tag.length);
    samen.set(ct); samen.set(tag, ct.length);
    var p = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(d.iv) }, key, samen)));
    document.title = p.titel;
    document.body.innerHTML = p.html;
    var knop = document.getElementById('pdf-knop');
    if (knop && p.pdf) {
      knop.addEventListener('click', function () {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes(p.pdf)], { type: 'application/pdf' }));
        a.download = p.pdfnaam || 'websitecheck.pdf';
        document.body.appendChild(a); a.click(); a.remove();
      });
    }
  } catch (e) {
    melding('Deze link is niet compleet', 'Open de link precies zoals je hem kreeg, met alles na het #-teken.');
  }
})();
