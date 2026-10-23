/* Tabblad Nieuws van het AIS-dashboard: berichten voor ais-groep.nl/nieuws schrijven, inplannen en beheren.
   Opslag: de privé-repo gzivanovic-cmyk/ais-nieuws via de GitHub-API, met een fine-grained token dat Goran zelf aanmaakt
   (alleen die repo, Contents lezen en schrijven). Het token staat versleuteld met het dashboardwachtwoord op dit toestel.
   Eén bestand per bericht (berichten/<id>.json), beelden in beelden/. De site-build neemt alleen berichten mee met
   status "klaar" en een publicatie die voorbij is; tijden staan altijd in Nederlandse tijd (Europe/Amsterdam).
   Lokaal (localhost) werkt alles op een testopslag in deze browser; er gaat dan niets naar GitHub.
   md() volgt precies dezelfde regels als nieuws_bron.py in de site, zodat het voorbeeld klopt met de echte pagina. */
window.AISNieuws = (function () {
  'use strict';
  var REPO = 'gzivanovic-cmyk/ais-nieuws';
  var TZ = 'Europe/Amsterdam';
  var RUBRIEKEN = ['Tips voor de speciaalzaak', 'Promesse', 'Leveranciers en prijzen', 'Klantverhalen', 'Websites', 'Nieuws'];
  var VASTE_ADRESSEN = ['ais-maakt-nu-ook-websites', 'software-op-maat-zonder-gedoe', 'ketenintegratie', 'veel-verschillende-leveranciers'];
  var FOTOMAAT = 'Liggend, minimaal 1600 × 1000 pixels';   // komt terug als 4:3 (artikel), 16:10 (kaartje) en 1200 × 630 (delen)
  var GRENS = 70;   // SEO-score: daaronder vraagt het dashboard of je echt wilt publiceren
  var ctx = null, opslag = null, berichten = [], filter = 'alle', zoek = '', geladen = false, laden = null;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var pad2 = function (n) { return ('0' + n).slice(-2); };

  // ---- tekst <-> base64 (utf-8) ------------------------------------------------------------------------------------
  function naarB64(tekst) { var b = new TextEncoder().encode(tekst), s = ''; for (var i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); }
  function uitB64(b64) { var s = atob(b64.replace(/\n/g, '')), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new TextDecoder().decode(u); }
  function bytesB64(buf) { var b = new Uint8Array(buf), s = ''; for (var i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return btoa(s); }

  // ---- Nederlandse tijd -------------------------------------------------------------------------------------------
  function delen(d) { var p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).forEach(function (x) { p[x.type] = x.value; }); p.hour = p.hour === '24' ? '00' : p.hour; return p; }
  function afwijking(t) { var p = delen(new Date(t)); return Math.round((Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000) / 60000); }
  function isoUit(datum, tijd) {   // '2026-11-03', '09:00' (Nederlandse tijd) -> '2026-11-03T09:00:00+01:00'
    var d = datum.split('-').map(Number), u = tijd.split(':').map(Number), gok = Date.UTC(d[0], d[1] - 1, d[2], u[0], u[1]);
    var t = gok - afwijking(gok) * 60000; t = gok - afwijking(t) * 60000;
    var o = afwijking(t), a = Math.abs(o);
    return datum + 'T' + pad2(u[0]) + ':' + pad2(u[1]) + ':00' + (o >= 0 ? '+' : '-') + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
  }
  function nuIso() { var p = delen(new Date()); return isoUit(p.year + '-' + p.month + '-' + p.day, p.hour + ':' + p.minute); }
  function datumVeld(iso) { var p = delen(new Date(iso)); return { datum: p.year + '-' + p.month + '-' + p.day, tijd: p.hour + ':' + p.minute }; }
  function toonTijd(iso, kort) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('nl-NL', kort ? { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }
      : { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ---- status -----------------------------------------------------------------------------------------------------
  function soort(b) {
    if (b.status === 'prullenbak') return 'prullenbak';
    if (b.status !== 'klaar' || !b.publicatie) return 'concept';
    return Date.parse(b.publicatie) > Date.now() ? 'ingepland' : 'gepubliceerd';
  }
  var SOORTNAAM = { concept: 'Concept', ingepland: 'Ingepland', gepubliceerd: 'Gepubliceerd', prullenbak: 'Prullenbak' };
  function pil(b) { var s = soort(b); return '<span class="st ' + s + '">' + SOORTNAAM[s] + '</span>'; }

  // ---- Markdown (zelfde regels als nieuws_bron.py) -----------------------------------------------------------------
  function kopId(t) {
    var s = t.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return 'h-' + (s || 'kop');
  }
  function inline(t) {
    t = esc(t);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, tekst, url) {
      var u = url.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      if (!/^(https?:\/\/|\/|#|mailto:|tel:)/.test(u)) return m;
      var extern = /^https?:/.test(u) && u.indexOf('ais-groep.nl') === -1;
      return '<a class="link" href="' + esc(u) + '"' + (extern ? ' target="_blank" rel="noopener"' : '') + '>' + tekst + '</a>';
    });
    t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    t = t.replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>');
    return t;
  }
  function md(tekst) {
    var r = String(tekst || '').replace(/\r/g, '').split('\n'), uit = [], koppen = [], gebruikt = {}, i = 0, m;
    var isBlokStart = function (x) { return /^(#{2,3}\s|>|\s*([-*]|\d+[.)])\s+)/.test(x); };
    while (i < r.length) {
      var regel = r[i];
      if (!regel.trim()) { i++; continue; }
      if ((m = regel.match(/^(#{2,3})\s+(.+)$/))) {
        var kt = inline(m[2].trim());
        if (m[1].length === 2) {
          var id = kopId(kt); gebruikt[id] = (gebruikt[id] || 0) + 1; if (gebruikt[id] > 1) id += '-' + gebruikt[id];
          koppen.push([id, kt]); uit.push('<h2 id="' + id + '">' + kt + '</h2>');
        } else uit.push('<h3>' + kt + '</h3>');
        i++; continue;
      }
      if ((m = regel.match(/^\s*([-*]|\d+[.)])\s+/))) {
        var genummerd = /\d/.test(m[1][0]), patroon = genummerd ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, items = [];
        while (i < r.length && patroon.test(r[i])) { items.push(inline(r[i].replace(patroon, '').trim())); i++; }
        var tag = genummerd ? 'ol' : 'ul';
        uit.push('<' + tag + '>' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</' + tag + '>');
        continue;
      }
      if (regel.charAt(0) === '>') {
        var blok = [];
        while (i < r.length && r[i].charAt(0) === '>') { blok.push(r[i].replace(/^>+/, '').trim()); i++; }
        uit.push('<blockquote><p>' + inline(blok.join(' ')) + '</p></blockquote>');
        continue;
      }
      var alinea = [];
      while (i < r.length && r[i].trim() && !isBlokStart(r[i])) { alinea.push(r[i].trim()); i++; }
      uit.push('<p>' + inline(alinea.join(' ')) + '</p>');
    }
    return { html: uit.join('\n'), koppen: koppen };
  }
  function woorden(t) { return (String(t || '').replace(/\]\([^)]*\)/g, ']').match(/[0-9A-Za-zÀ-ÿ]+/g) || []).length; }
  function maakSlug(t) {
    var s = String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (s.length > 60) { s = s.slice(0, 60); s = s.slice(0, s.lastIndexOf('-') > 30 ? s.lastIndexOf('-') : 60); }
    return s.replace(/-+$/, '');
  }
  function initialen(naam) {
    var d = String(naam || '').split(/[\s-]+/).filter(function (w) { return w && w[0] === w[0].toUpperCase() && /[A-Za-z]/.test(w[0]); });
    return (d.length > 1 ? d[0][0] + d[d.length - 1][0] : String(naam || 'AI').slice(0, 2)).toUpperCase();
  }

  // ---- SEO-controle (een checklist, geen Google-score) -------------------------------------------------------------
  function googleTitel(b) { var k = (b.seoTitel || b.titel || '').trim(); return /AIS/.test(k) ? k : k + ' | AIS-Groep'; }
  function googleOms(b) { return (b.seoBeschrijving || b.samenvatting || '').trim(); }
  function seo(b) {
    var p = [], n = woorden(b.tekst), gt = googleTitel(b), go = googleOms(b), koppen = (String(b.tekst || '').match(/^##\s+\S/gm) || []).length;
    var add = function (ok, tekst, min) { p.push({ ok: ok, tekst: tekst, min: ok ? 0 : min }); };
    add((b.titel || '').trim().length >= 20 && (b.titel || '').trim().length <= 75, 'Titel van 20 tot 75 tekens (nu ' + (b.titel || '').trim().length + ')', 5);
    add(gt.length <= 60, 'Titel in Google ' + gt.length + ' van max. 60 tekens' + (gt.length > 60 ? ': vul een kortere SEO-titel in' : ''), 10);
    add(!!(b.samenvatting || '').trim(), 'Korte samenvatting ingevuld', 10);
    add(go.length >= 70 && go.length <= 160, 'Omschrijving in Google ' + go.length + ' tekens (70 tot 160)', 10);
    add(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.slug || '') && (b.slug || '').length <= 60 && (b.slug || '').split('-').length <= 8, 'Kort, leesbaar webadres', 10);
    add(koppen >= 2, koppen >= 2 ? 'Tussenkoppen (' + koppen + ')' : 'Minstens twee tussenkoppen (## Kop)', 10);
    add(n >= 300, 'Minstens 300 woorden (nu ' + n + ')', 15);
    add(!!b.beeld, 'Omslagfoto toegevoegd', 10);
    add(!b.beeld || !!(b.beeldAlt || '').trim(), 'Beschrijving bij de foto', 5);
    add(/\]\(\/[a-z]/.test(b.tekst || ''), 'Link naar een andere pagina van de site, bijv. [Promesse](/promesse/)', 5);
    var score = Math.max(0, 100 - p.reduce(function (s, x) { return s + x.min; }, 0));
    return { score: score, punten: p };
  }
  function scoreKlas(s) { return s >= 80 ? 'sc-goed' : s >= GRENS ? 'sc-beter' : 'sc-actie'; }

  // ---- opslag: GitHub of (lokaal) een testopslag in deze browser --------------------------------------------------
  function GitHub(token) {
    var basis = 'https://api.github.com/repos/' + REPO, blobs = {}, rij = Promise.resolve();
    var kop = function (extra) { return Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, extra || {}); };
    async function api(pad, opties) {
      var r = await fetch(basis + pad, Object.assign({ cache: 'no-store', headers: kop(opties && opties.body ? { 'Content-Type': 'application/json' } : null) }, opties || {}));
      if (r.status === 401) throw Object.assign(new Error('sleutel'), { soort: 'sleutel' });
      if (r.status === 409 || (r.status === 422 && /sha/i.test(await r.clone().text()))) throw Object.assign(new Error('conflict'), { soort: 'conflict' });
      if (!r.ok) throw new Error('GitHub gaf ' + r.status);
      return r.status === 204 ? null : r.json();
    }
    // schrijfacties na elkaar, anders weigert GitHub er een (twee commits tegelijk op main)
    function opRij(doe) { var p = rij.then(doe, doe); rij = p.catch(function () {}); return p; }
    var enc = function (p) { return p.split('/').map(encodeURIComponent).join('/'); };
    return {
      echt: true,
      controleer: async function () { var r = await api(''); if (!r.permissions || !r.permissions.push) throw new Error('alleen-lezen'); return true; },
      lijst: async function () { var t = await api('/git/trees/main?recursive=1'); return t.tree.filter(function (x) { return x.type === 'blob'; }).map(function (x) { return { pad: x.path, sha: x.sha }; }); },
      leesBlob: async function (sha) { if (!blobs[sha]) blobs[sha] = api('/git/blobs/' + sha).then(function (b) { return b.content; }); return blobs[sha]; },
      schrijf: function (pad, b64, sha, bericht) {
        return opRij(async function () { var r = await api('/contents/' + enc(pad), { method: 'PUT', body: JSON.stringify({ message: bericht, content: b64, sha: sha || undefined, branch: 'main' }) }); return r.content.sha; });
      },
      wis: function (pad, sha, bericht) { return opRij(function () { return api('/contents/' + enc(pad), { method: 'DELETE', body: JSON.stringify({ message: bericht, sha: sha, branch: 'main' }) }); }); }
    };
  }
  function TestOpslag() {
    var SLEUTEL = 'ais-nieuws-test', bestanden = {};
    try { bestanden = JSON.parse(sessionStorage.getItem(SLEUTEL) || '{}'); } catch (e) {}
    var bewaar = function () { try { var json = {}; Object.keys(bestanden).forEach(function (p) { if (/\.json$/.test(p)) json[p] = bestanden[p]; }); sessionStorage.setItem(SLEUTEL, JSON.stringify(json)); } catch (e) {} };
    var nieuweSha = function () { return Math.random().toString(16).slice(2) + Date.now().toString(16); };
    var WEG = 'ais-nieuws-test-weg', weg = []; try { weg = JSON.parse(sessionStorage.getItem(WEG) || '[]'); } catch (e) {}
    // drie voorbeeldberichten om de lijst en de planning te proberen, ingepland op de dinsdagen na volgende week (09:30)
    async function zaai() {
      var p = delen(new Date()), vandaag = Date.UTC(+p.year, p.month - 1, +p.day), dinsdag = vandaag + (((9 - new Date(vandaag).getUTCDay()) % 7) || 7) * 864e5;
      VOORBEELDEN.forEach(function (v, i) {
        var pad = 'berichten/' + v.id + '.json';
        if (bestanden[pad] || weg.indexOf(pad) !== -1) return;
        var b = schoon(Object.assign(leeg(), v, { status: 'klaar', publicatie: isoUit(new Date(dinsdag + (i + 2) * 7 * 864e5).toISOString().slice(0, 10), '09:30') }));
        bestanden[pad] = { b64: naarB64(JSON.stringify(b, null, 2)), sha: nieuweSha() };
      });
      bewaar();
      await Promise.all(VOORBEELDEN.map(async function (v) {   // foto's alleen in het geheugen (te groot voor sessionStorage)
        if (bestanden[v.beeld]) return;
        try { var r = await fetch('data-test/voorbeeld/' + v.beeld.split('/').pop()); if (r.ok) bestanden[v.beeld] = { b64: bytesB64(await r.arrayBuffer()), sha: nieuweSha() }; } catch (e) {}
      }));
    }
    var gezaaid = null;
    return {
      echt: false,
      controleer: async function () { return true; },
      lijst: async function () { gezaaid = gezaaid || zaai(); await gezaaid; return Object.keys(bestanden).map(function (p) { return { pad: p, sha: bestanden[p].sha }; }); },
      leesBlob: async function (sha) { var p = Object.keys(bestanden).find(function (x) { return bestanden[x].sha === sha; }); return p ? bestanden[p].b64 : ''; },
      schrijf: async function (pad, b64, sha) { if (bestanden[pad] && bestanden[pad].sha !== sha) throw Object.assign(new Error('conflict'), { soort: 'conflict' }); bestanden[pad] = { b64: b64, sha: nieuweSha() }; bewaar(); return bestanden[pad].sha; },
      wis: async function (pad) { delete bestanden[pad]; weg.push(pad); try { sessionStorage.setItem(WEG, JSON.stringify(weg)); } catch (e) {} bewaar(); }
    };
  }
  // alleen voor de lokale test; feiten zoals ze op de site staan
  var VOORBEELDEN = [
    { id: 'voorbeeld-prijzen', titel: 'Altijd de juiste prijzen: zo werken de prijsupdates in Promesse', slug: 'prijsupdates-promesse', rubriek: 'Leveranciers en prijzen',
      samenvatting: 'Nieuwe prijzen van uw leveranciers staan in Promesse voor u klaar. U kijkt ze na en accepteert ze met één klik.',
      kort: ['AIS houdt de prijzen van ruim 150 leveranciers bij', 'Nieuwe prijzen staan voor u klaar', 'U accepteert ze met één klik'],
      beeld: 'beelden/prijzen.jpg', beeldAlt: 'Verfblikken op een schap in een verfspeciaalzaak',
      tekst: 'Prijzen van leveranciers veranderen regelmatig. Wie dat met de hand bijhoudt, is er al snel uren mee bezig, en een fout zie je pas aan de kassa.\n\n## Wij houden de prijzen bij\nAIS houdt de prijzen van ruim 150 leveranciers voor u bij. Komt er een nieuwe prijslijst, dan zetten wij die in Promesse voor u klaar.\n\n## U accepteert met één klik\nU ziet precies wat er verandert. Klopt het, dan accepteert u de nieuwe prijzen met één klik. Uw schaplabels print u daarna ook met één klik.\n\nMeer weten? Lees over [artikelbeheer](/artikelbeheer/).' },
    { id: 'voorbeeld-inmeten', titel: 'Inmeten aan huis met de app: van raam tot offerte', slug: 'inmeten-met-de-app', rubriek: 'Promesse',
      samenvatting: 'Met de inmeet-app legt u per raam de maten vast bij de klant thuis. Promesse rekent de offerte daarna zelf uit.',
      kort: ['Per raam inmeten met de app', 'Promesse rekent stof, plooi, confectie en montage uit', 'De offerte staat meteen klaar'],
      beeld: 'beelden/inmeten.jpg', beeldAlt: 'Adviseur meet een raam in bij een klant thuis',
      tekst: 'Bij gordijnen en raamdecoratie begint alles met goed inmeten. Een vergeten maat kost u een extra rit, of erger: een product dat niet past.\n\n## Per raam inmeten\nMet de inmeet-app van Promesse legt u bij de klant thuis per raam de maten vast. Zo heeft u alles compleet voordat u weer in de auto stapt.\n\n## Promesse rekent het uit\nStof, plooi, confectie en montage: Promesse rekent het maatwerk zelf voor u uit. Uw offerte staat daardoor meteen klaar.\n\nLees meer over [Promesse voor woninginrichting](/branches/woninginrichting/).' },
    { id: 'voorbeeld-mengkleuren', titel: 'Mengkleuren per klant bewaren: nooit meer zoeken naar die ene kleur', slug: 'mengkleuren-per-klant', rubriek: 'Tips voor de speciaalzaak',
      samenvatting: 'Een klant wil dezelfde kleur als vorig jaar? In Promesse staat elke mengkleur bij de klant, dus u heeft hem zo gevonden.',
      kort: ['Elke mengkleur staat bij de klant', 'Snel terug te vinden aan de toonbank', 'Ook handig voor schilders op rekening'],
      beeld: 'beelden/mengen.jpg', beeldAlt: 'Verf wordt gemengd aan de toonbank van een verfwinkel',
      tekst: '"Dezelfde kleur als vorig jaar, graag." Als niemand meer weet welke kleur dat was, begint het zoeken.\n\n## Elke kleur bij de klant\nIn Promesse slaat u elke mengkleur op bij de klant. Komt hij terug, dan zoekt u de klant op en ziet u meteen wat er de vorige keer is gemengd.\n\n## Handig voor schilders\nVoor schilders die op rekening kopen werkt het net zo. U ziet per klant welke kleuren en producten zij gebruiken.\n\nLees meer over [Promesse voor verf en wand](/branches/verf-en-wand/).' }
  ];

  // ---- token versleuteld bewaren (met het dashboardwachtwoord) -----------------------------------------------------
  var TOKENSLEUTEL = 'ais-nieuws-github';
  async function aesSleutel(pw, salt) {
    var basis = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: 310000, hash: 'SHA-256' }, basis, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function bewaarToken(token) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, await aesSleutel(ctx.pw(), salt), new TextEncoder().encode(token));
    try { localStorage.setItem(TOKENSLEUTEL, JSON.stringify({ salt: bytesB64(salt), iv: bytesB64(iv), ct: bytesB64(ct) })); } catch (e) {}
  }
  async function leesToken() {
    var o; try { o = JSON.parse(localStorage.getItem(TOKENSLEUTEL) || 'null'); } catch (e) { o = null; }
    if (!o) return null;
    var b = function (s) { var x = atob(s), u = new Uint8Array(x.length); for (var i = 0; i < x.length; i++) u[i] = x.charCodeAt(i); return u; };
    try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(o.iv) }, await aesSleutel(ctx.pw(), b(o.salt)), b(o.ct))); }
    catch (e) { return null; }   // ander wachtwoord: opnieuw koppelen
  }
  function vergeetToken() { try { localStorage.removeItem(TOKENSLEUTEL); } catch (e) {} }

  // ---- berichten laden --------------------------------------------------------------------------------------------
  var beeldUrl = {};   // pad -> object-URL (beelden in een privé-repo kun je niet rechtstreeks tonen)
  var bestandSha = {}; // pad -> sha (nodig om een bestand te overschrijven)
  async function laad() {
    var lijst = await opslag.lijst();
    bestandSha = {}; lijst.forEach(function (x) { bestandSha[x.pad] = x.sha; });
    var json = lijst.filter(function (x) { return /^berichten\/[^/]+\.json$/.test(x.pad); });
    var uit = await Promise.all(json.map(async function (x) {
      try { var b = JSON.parse(uitB64(await opslag.leesBlob(x.sha))); b._pad = x.pad; b._sha = x.sha; return b; } catch (e) { return null; }
    }));
    berichten = uit.filter(Boolean);
    geladen = true;
  }
  async function beeld(pad) {
    if (!pad) return '';
    if (beeldUrl[pad]) return beeldUrl[pad];
    var sha = bestandSha[pad]; if (!sha) return '';
    var b64 = await opslag.leesBlob(sha), s = atob(b64.replace(/\n/g, '')), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    beeldUrl[pad] = URL.createObjectURL(new Blob([u], { type: /\.png$/.test(pad) ? 'image/png' : 'image/jpeg' }));
    return beeldUrl[pad];
  }

  // ---- overzicht --------------------------------------------------------------------------------------------------
  function fout(e) {
    if (e && e.soort === 'sleutel') { vergeetToken(); opslag = null; ctx.toast('Je GitHub-sleutel werkt niet meer (verlopen of ingetrokken). Koppel opnieuw.'); toon(); return; }
    ctx.toast(e && e.soort === 'conflict' ? 'Dit bericht is intussen op een ander toestel gewijzigd. Open het opnieuw.' : 'Dat lukte niet: ' + ((e && e.message) || 'onbekende fout') + '. Probeer het zo nog eens.');
  }
  async function toon() {
    var doos = $('nieuws');
    if (!opslag) {
      if (ctx.lokaal) opslag = TestOpslag();
      else { var token = await leesToken(); if (token) opslag = GitHub(token); }
    }
    if (!opslag) { koppelScherm(doos); return; }
    if (!geladen) {
      doos.innerHTML = '<p class="sub">Berichten laden…</p>';
      try { laden = laden || laad(); await laden; } catch (e) { laden = null; fout(e); if (opslag) doos.innerHTML = '<div class="leeg">Berichten laden lukte niet. <button class="knop licht" type="button" id="n-opnieuw">Opnieuw</button></div>'; if ($('n-opnieuw')) $('n-opnieuw').onclick = toon; return; }
      laden = null;
    }
    tekenLijst();
  }
  function tekenLijst() {
    var doos = $('nieuws'), tel = { concept: 0, ingepland: 0, gepubliceerd: 0, prullenbak: 0, aandacht: 0 };
    berichten.forEach(function (b) { var s = soort(b); tel[s]++; if (s !== 'prullenbak' && seo(b).score < GRENS) tel.aandacht++; });
    var rijen = berichten.filter(function (b) {
      var s = soort(b);
      if (filter === 'alle' ? s === 'prullenbak' : filter === 'aandacht' ? (s === 'prullenbak' || seo(b).score >= GRENS) : s !== filter) return false;
      return !zoek || ((b.titel || '') + ' ' + (b.samenvatting || '') + ' ' + (b.rubriek || '')).toLowerCase().indexOf(zoek) !== -1;
    }).sort(function (a, b) {
      var sa = soort(a), sb = soort(b), va = { ingepland: 0, concept: 1, gepubliceerd: 2, prullenbak: 3 };
      if (filter === 'alle' && va[sa] !== va[sb]) return va[sa] - va[sb];
      if (sa === 'ingepland' && sb === 'ingepland') return Date.parse(a.publicatie) - Date.parse(b.publicatie);   // eerstvolgende bovenaan
      return (b.publicatie || b.gewijzigd || '').localeCompare(a.publicatie || a.gewijzigd || '') || (b.gewijzigd || '').localeCompare(a.gewijzigd || '');
    });
    var UITLEG = { aandacht: 'Berichten met een SEO-score onder ' + GRENS + ' (het rondje rechts op elk kaartje)' };
    var knop = function (v, t) { return '<button data-nf="' + v + '"' + (filter === v ? ' class="aan"' : '') + (UITLEG[v] ? ' title="' + UITLEG[v] + '"' : '') + '>' + t + '</button>'; };
    // ingeplande berichten als planning (volgorde aanpasbaar), behalve tijdens zoeken
    var plan = (filter === 'alle' || filter === 'ingepland') && !zoek ? rijen.filter(function (b) { return soort(b) === 'ingepland'; }) : [];
    var rest = rijen.filter(function (b) { return plan.indexOf(b) === -1; });
    doos.innerHTML =
      '<div class="n-kop"><div><h2 class="kop2">Nieuws<em>berichten</em></h2><p class="sub" style="margin-bottom:0">Schrijf, plan en beheer de berichten voor ais-groep.nl/nieuws. Tijden zijn altijd Nederlandse tijd.</p></div>' +
      '<div class="n-kopknoppen">' + (opslag.echt ? '<button class="knop licht" type="button" id="n-toestel">Ander toestel koppelen</button>' : '') + '<button class="knop goud" type="button" id="n-nieuw">+ Nieuw bericht</button></div></div>' +
      (opslag.echt ? '<p class="n-noot" style="margin-top:14px">De nieuwe site staat nog niet live. Gepubliceerde berichten verschijnen nu op de conceptsite; zodra de site live staat, komen ze vanzelf op <b>ais-groep.nl/nieuws</b>.</p>'
        : '<p class="testbalk" style="margin-top:14px">Lokale test: berichten blijven in deze browser en gaan <b>niet</b> naar GitHub of de site.</p>') +
      '<div class="kpis">' + [[tel.concept, 'concepten'], [tel.ingepland, 'ingepland'], [tel.gepubliceerd, 'gepubliceerd'], [tel.aandacht, 'nog verbeteren']]
        .map(function (k) { return '<div class="kpi"><b>' + k[0] + '</b><span>' + k[1] + '</span></div>'; }).join('') + '</div>' +
      '<div class="tools"><div class="seg" id="n-filter">' + knop('alle', 'Alles') + knop('concept', 'Concepten') + knop('ingepland', 'Ingepland') + knop('gepubliceerd', 'Gepubliceerd') + knop('aandacht', 'Nog verbeteren') + knop('prullenbak', 'Prullenbak' + (tel.prullenbak ? ' (' + tel.prullenbak + ')' : '')) + '</div>' +
      '<input class="zoek" id="n-zoek" type="search" placeholder="Zoek in titel of samenvatting" aria-label="Zoek in berichten" value="' + esc(zoek) + '"></div>' +
      (plan.length ? planHtml(plan) + (rest.length ? '<h3 class="n-sub">Overige berichten</h3>' : '') : '') +
      (rest.length ? '<div class="n-lijst">' + rest.map(function (b) { return kaart(b); }).join('') + '</div>'
        : plan.length ? '' : '<div class="leeg">' + (filter === 'aandacht' && !zoek ? 'Alle berichten hebben een SEO-score van ' + GRENS + ' of hoger. Mooi zo.' : berichten.length ? 'Niets gevonden met dit filter.' : 'Nog geen berichten. Klik op <b>Nieuw bericht</b> om te beginnen.') + '</div>');
    $('n-nieuw').onclick = function () { openEditor(null); };
    if ($('n-toestel')) $('n-toestel').onclick = toestelScherm;
    $('n-filter').onclick = function (e) { var b = e.target.closest('button'); if (b) { filter = b.dataset.nf; tekenLijst(); } };
    $('n-zoek').oninput = function () { zoek = this.value.toLowerCase().trim(); var pos = this.selectionStart; tekenLijst(); var z = $('n-zoek'); z.focus(); z.setSelectionRange(pos, pos); };
    doos.querySelectorAll('[data-nid]').forEach(function (k) { k.onclick = function () { if (!sleepNet) openEditor(k.dataset.nid); }; });
    if (plan.length) koppelPlan();
    doos.querySelectorAll('[data-nbeeld]').forEach(function (el) { beeld(el.dataset.nbeeld).then(function (u) { if (u) { el.style.backgroundImage = 'url(' + u + ')'; el.textContent = ''; } else el.textContent = 'Geen foto'; }).catch(function () { el.textContent = 'Geen foto'; }); });
  }
  function kaart(b, inPlanning) {
    var s = soort(b), sc = seo(b).score;
    var wanneer = inPlanning ? '' : s === 'ingepland' ? 'Gaat online ' + toonTijd(b.publicatie) : s === 'gepubliceerd' ? toonTijd(b.publicatie, true) : 'Gewijzigd ' + toonTijd(b.gewijzigd, true);
    return '<button type="button" class="nk" data-nid="' + esc(b.id) + '">' +
      '<span class="nk-beeld"' + (b.beeld ? ' data-nbeeld="' + esc(b.beeld) + '"' : '') + '>' + (b.beeld ? '' : 'Geen foto') + '</span>' +
      '<span><span class="meta">' + pil(b) + (wanneer ? '<span>' + esc(wanneer) + '</span>' : '') + (b.rubriek ? '<span>' + (wanneer ? '· ' : '') + esc(b.rubriek) + '</span>' : '') + '</span>' +
      '<h3>' + esc(b.titel || 'Zonder titel') + '</h3>' + (b.samenvatting ? '<p>' + esc(b.samenvatting) + '</p>' : '') + '</span>' +
      '<span class="n-score ' + scoreKlas(sc) + '" title="SEO-controle">' + sc + '</span></button>';
  }

  // ---- planning: de momenten blijven staan, de berichten schuiven erlangs ----------------------------------------
  function planHtml(plan) {
    var tijd = function (b) { var d = new Date(b.publicatie); return '<b>' + esc(d.toLocaleDateString('nl-NL', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })) + '</b><small>' + esc(d.toLocaleTimeString('nl-NL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })) + '</small>'; };
    return '<div class="n-plankop"><h3>Planning</h3><p>' + (plan.length > 1 ? 'Sleep een bericht (of gebruik de pijltjes) om de volgorde te bepalen. De momenten links blijven staan; de berichten schuiven erlangs.' : 'Plan meer berichten in, dan kun je hier de volgorde bepalen.') + '</p></div>' +
      '<div class="n-planrij"><ol class="n-momenten" aria-label="Publicatiemomenten">' + plan.map(function (b) { return '<li>' + tijd(b) + '</li>'; }).join('') + '</ol>' +
      '<ol class="n-plan" id="n-plan" aria-label="Volgorde van de ingeplande berichten">' + plan.map(function (b, i) {
        return '<li class="np" data-pid="' + esc(b.id) + '">' + (plan.length > 1 ? '<span class="np-knoppen"><button type="button" class="np-pijl" data-stap="-1" aria-label="Eerder plannen"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<span class="np-greep" aria-hidden="true" title="Slepen">⋮⋮</span><button type="button" class="np-pijl" data-stap="1" aria-label="Later plannen"' + (i === plan.length - 1 ? ' disabled' : '') + '>↓</button></span>' : '') + kaart(b, true) + '</li>';
      }).join('') + '</ol></div>';
  }
  var sleepNet = false;   // na slepen geen klik doorlaten (anders opent de editor)
  function koppelPlan() {
    var lijst = $('n-plan'), volgorde = function () { return [].map.call(lijst.children, function (li) { return li.dataset.pid; }); };
    lijst.querySelectorAll('.np-pijl').forEach(function (k) {
      k.onclick = function (e) {
        e.stopPropagation();
        var ids = volgorde(), i = ids.indexOf(k.closest('.np').dataset.pid), j = i + +k.dataset.stap;
        if (j < 0 || j >= ids.length) return;
        ids.splice(j, 0, ids.splice(i, 1)[0]); herplan(ids, ids[j]);
      };
    });
    lijst.querySelectorAll('.np').forEach(function (li) {
      var greep = li.querySelector('.np-greep'); if (!greep) return;
      // slepen aan de greep, of (met muis of pen) aan de hele kaart; op een telefoon alleen aan de greep, zodat scrollen blijft werken
      li.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 || e.target.closest('.np-pijl') || (e.pointerType === 'touch' && !e.target.closest('.np-greep'))) return;
        var start = e.clientY, voor = volgorde().join(), bewogen = false;
        var beweeg = function (ev) {
          if (ev.pointerId !== e.pointerId) return;
          if (!bewogen && Math.abs(ev.clientY - start) < 6) return;
          if (!bewogen) { bewogen = true; li.classList.add('sleept'); lijst.classList.add('bezig'); try { li.setPointerCapture(e.pointerId); } catch (x) {} }   // pas nu vastpakken: een gewone klik moet het bericht blijven openen
          ev.preventDefault();
          // bij een snelle beweging meerdere plekken tegelijk opschuiven
          for (var n = 0; n < 50; n++) {
            var dy = ev.clientY - start, vorige = li.previousElementSibling, volgende = li.nextElementSibling, top = li.offsetTop;
            if (volgende && dy > volgende.offsetHeight / 2) lijst.insertBefore(volgende, li);
            else if (vorige && -dy > vorige.offsetHeight / 2) lijst.insertBefore(li, vorige);
            else break;
            start += li.offsetTop - top;
          }
          li.style.transform = 'translateY(' + (ev.clientY - start) + 'px)';
        };
        var los = function (ev) {
          if (ev.pointerId !== e.pointerId) return;
          document.removeEventListener('pointermove', beweeg); document.removeEventListener('pointerup', los); document.removeEventListener('pointercancel', los);
          li.classList.remove('sleept'); lijst.classList.remove('bezig'); li.style.transform = '';
          if (!bewogen) return;
          sleepNet = true; setTimeout(function () { sleepNet = false; }, 50);
          if (volgorde().join() !== voor) herplan(volgorde(), li.dataset.pid);
        };
        document.addEventListener('pointermove', beweeg, { passive: false }); document.addEventListener('pointerup', los); document.addEventListener('pointercancel', los);
      });
    });
  }
  async function bewaarBericht(b, wat) {   // alleen het JSON-bestand (de deelafbeelding hangt niet af van het moment)
    b.gewijzigd = nuIso();
    var sha = await opslag.schrijf(b._pad, naarB64(JSON.stringify(schoon(b), null, 2) + '\n'), b._sha, 'Nieuws: ' + b.titel + ' (' + wat + ')');
    b._sha = sha; bestandSha[b._pad] = sha;
  }
  async function herplan(ids, verschoven) {
    var plan = ids.map(function (id) { return berichten.find(function (x) { return x.id === id; }); });
    var tijden = plan.map(function (b) { return b.publicatie; }).sort(function (a, c) { return Date.parse(a) - Date.parse(c); });
    var anders = plan.map(function (b, i) { return { b: b, oud: b.publicatie, nieuw: tijden[i] }; }).filter(function (x) { return x.oud !== x.nieuw; });
    if (!anders.length) { tekenLijst(); return; }
    anders.forEach(function (x) { x.b.publicatie = x.nieuw; });
    tekenLijst();
    var li = document.querySelector('.np[data-pid="' + verschoven + '"]'); if (li) { li.classList.add('net'); var k = li.querySelector('.np-pijl:not([disabled])'); if (k && document.activeElement && document.activeElement.classList.contains('np-pijl')) k.focus(); }
    try {
      for (var i = 0; i < anders.length; i++) await bewaarBericht(anders[i].b, 'verschoven naar ' + toonTijd(anders[i].nieuw));
      var b = berichten.find(function (x) { return x.id === verschoven; });
      ctx.toast('Volgorde opgeslagen. "' + (b.titel.length > 48 ? b.titel.slice(0, 46) + '…' : b.titel) + '" gaat nu online op ' + toonTijd(b.publicatie) + '.');
    } catch (e) {
      fout(e); geladen = false; toon();   // opnieuw inlezen: dan klopt de lijst weer met wat er echt is opgeslagen
    }
  }

  // ---- ander toestel koppelen: sleutel kopiëren (Apple's gedeelde klembord zet hem op de iPhone) -------------------
  function toestelScherm() {
    var m = document.createElement('div'); m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    m.innerHTML = '<div class="mk n-toestel"><h3>Ander toestel koppelen</h3>' +
      '<ol><li>Klik hieronder op <b>Sleutel kopiëren</b>.</li><li>Open het dashboard op je iPhone, liefst als app op je beginscherm (Deel → Zet op beginscherm), en log in.</li>' +
      '<li>Ga naar <b>Nieuws</b>, tik in het sleutelveld, kies <b>Plak</b> en tik op <b>Koppelen</b>. Je iPhone en Mac delen het klembord als ze bij hetzelfde Apple ID horen en dichtbij zijn.</li>' +
      '<li>Vraagt je iPhone of hij de sleutel mag bewaren? Kies <b>Bewaar</b>. Dan is het volgende toestel één tik.</li></ol>' +
      '<p class="ne-hint">De sleutel staat daarna maar een paar minuten op het klembord. Deel hem niet met anderen.</p>' +
      '<div class="rk"><button class="knop licht" type="button" data-nt="sluit">Sluiten</button><button class="knop" type="button" id="nt-kopie">Sleutel kopiëren</button></div></div>';
    document.body.appendChild(m);
    var sluit = function () { m.remove(); document.removeEventListener('keydown', toets); }, toets = function (e) { if (e.key === 'Escape') sluit(); };
    document.addEventListener('keydown', toets);
    m.addEventListener('click', function (e) { if (e.target === m || e.target.getAttribute('data-nt') === 'sluit') sluit(); });
    $('nt-kopie').onclick = async function () {
      var k = this;
      try {
        var t = await leesToken(); if (!t) throw new Error('geen sleutel');
        await navigator.clipboard.writeText(t);
        k.textContent = 'Gekopieerd'; ctx.toast('Sleutel gekopieerd. Plak hem binnen een paar minuten op je andere toestel.');
      } catch (e) { ctx.toast('Kopiëren lukte niet. Probeer het nog eens.'); }
    };
  }

  // ---- koppelen met GitHub ----------------------------------------------------------------------------------------
  function koppelScherm(doos) {
    var url = 'https://github.com/settings/personal-access-tokens/new?name=' + encodeURIComponent('AIS-dashboard nieuws') +
      '&description=' + encodeURIComponent('Nieuwsberichten schrijven vanuit het AIS-dashboard') + '&target_name=gzivanovic-cmyk&expires_in=365&contents=write';
    var app = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true, iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    doos.innerHTML = '<h2 class="kop2">Nieuws<em>berichten</em></h2><p class="sub">Schrijf, plan en beheer de berichten voor ais-groep.nl/nieuws. Ze worden bewaard in je privé-opslag <b>ais-nieuws</b> op GitHub, met elke versie erbij.</p>' +
      '<div class="n-koppel"><h3>Dit toestel koppelen</h3>' +
      (iOS && !app ? '<p class="n-tip"><b>Tip:</b> gebruik het dashboard als app (Deel → Zet op beginscherm) en koppel daar. In Safari zelf kan je iPhone bewaarde gegevens wissen als je de site een week niet opent; in de app blijft het staan.</p>' : '') +
      '<p class="ne-hint">Plak je sleutel hieronder. Heb je hem al op je Mac gekoppeld? Kies daar bij Nieuws <b>Ander toestel koppelen → Sleutel kopiëren</b> en plak hem hier. Of tik in het veld en kies hem uit je bewaarde wachtwoorden.</p>' +
      '<form class="rij2" id="n-koppelform" autocomplete="on"><input class="n-onzichtbaar" type="text" name="username" autocomplete="username" value="AIS-dashboard nieuws (GitHub-sleutel)" tabindex="-1" aria-hidden="true">' +
      '<input id="n-token" name="password" type="password" autocomplete="current-password" placeholder="github_pat_…" aria-label="GitHub-sleutel"><button class="knop" type="submit" id="n-koppel">Koppelen</button></form>' +
      '<p class="ne-hint" style="margin-top:10px">Na het koppelen vraagt je browser of hij de sleutel mag bewaren: kies <b>Bewaar</b>. Dan staat hij in je iCloud-wachtwoorden en is elk volgend toestel één tik. De sleutel wordt hier versleuteld met je dashboardwachtwoord bewaard.</p>' +
      '<details class="n-nieuwesleutel"><summary>Nog geen sleutel? Zo maak je er een</summary><ol>' +
      '<li><a href="' + url + '" target="_blank" rel="noopener"><b>Open GitHub: nieuwe sleutel maken</b></a> (log in als gzivanovic-cmyk).</li>' +
      '<li>Bij <b>Expiration</b>: kies de langste termijn, of geen einddatum.</li>' +
      '<li>Bij <b>Repository access</b>: kies <b>Only select repositories</b> en dan alleen <code>ais-nieuws</code>. Niet <i>All repositories</i>.</li>' +
      '<li>Bij <b>Permissions → Repository permissions</b>: zet <b>Contents</b> op <b>Read and write</b>. De rest laat je zoals het is.</li>' +
      '<li>Klik op <b>Generate token</b>, kopieer de code (begint met <code>github_pat_</code>) en plak hem hierboven.</li>' +
      '<li>Let op: een nieuwe sleutel maken (of de oude vernieuwen) betekent dat je je andere toestellen ook opnieuw koppelt. Met de bewaarde sleutel is dat één tik.</li></ol></details></div>';
    $('n-koppelform').onsubmit = function (e) { e.preventDefault(); $('n-koppel').click(); };
    $('n-koppel').onclick = async function (e) {
      if (e) e.preventDefault();
      var t = $('n-token').value.trim(), k = this;
      if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(t)) { ctx.toast('Dat lijkt geen GitHub-sleutel. Hij begint met github_pat_.'); return; }
      k.textContent = 'Controleren…'; k.disabled = true;
      try {
        var o = GitHub(t); await o.controleer(); await bewaarToken(t); opslag = o; geladen = false; $('n-token').value = '';
        ctx.toast('Gekoppeld. Je kunt nu berichten schrijven.'); toon();
      } catch (e) {
        k.textContent = 'Koppelen'; k.disabled = false;
        ctx.toast(e.message === 'alleen-lezen' ? 'Deze sleutel mag alleen lezen. Zet Contents op Read and write.' : e.soort === 'sleutel' || /404/.test(e.message) ? 'Deze sleutel kan niet bij ais-nieuws. Kies die opslag bij Repository access.' : 'Koppelen lukte niet: ' + e.message);
      }
    };
  }

  // ---- editor -----------------------------------------------------------------------------------------------------
  var ed = null;   // { b: bericht in bewerking, orig: JSON van de opgeslagen versie, slugVrij, wanneer, voorbeeld, deelStijl }
  function leeg() {
    var p = delen(new Date());
    return { id: p.year + '-' + p.month + '-' + p.day + '-' + Math.random().toString(36).slice(2, 6), titel: '', slug: '', samenvatting: '', kort: ['', '', ''], rubriek: RUBRIEKEN[0],
      auteur: 'AIS-Groep', beeld: '', beeldAlt: '', deelbeeld: '', deelStijl: 'foto', tekst: '', seoTitel: '', seoBeschrijving: '', status: 'concept', publicatie: null, oudeSlugs: [], aangemaakt: nuIso(), gewijzigd: nuIso() };
  }
  var VELDEN = ['id', 'titel', 'slug', 'samenvatting', 'kort', 'rubriek', 'auteur', 'beeld', 'beeldAlt', 'deelbeeld', 'deelStijl', 'tekst', 'seoTitel', 'seoBeschrijving', 'status', 'publicatie', 'oudeSlugs', 'aangemaakt', 'gewijzigd'];
  function schoon(b) { var o = {}; VELDEN.forEach(function (k) { o[k] = b[k] === undefined ? null : b[k]; }); o.kort = (b.kort || []).slice(0, 3); while (o.kort.length < 3) o.kort.push(''); o.oudeSlugs = b.oudeSlugs || []; return o; }
  function gewijzigd() { return ed && JSON.stringify(schoon(ed.b)) !== ed.orig; }
  var KLAD = function (id) { return 'ais-nieuws-klad-' + id; };

  function losseKlad() {   // klad van een nieuw bericht dat nooit is opgeslagen (bijv. venster dicht of batterij leeg)
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i), id = k.indexOf('ais-nieuws-klad-') === 0 ? k.slice(16) : null;
        if (id && !berichten.some(function (x) { return x.id === id; })) { var o = JSON.parse(localStorage.getItem(k)); if (o && o.b) return o; }
      }
    } catch (e) {}
    return null;
  }
  async function openEditor(id) {
    var bestaand = id ? berichten.find(function (x) { return x.id === id; }) : null, los = !id && losseKlad();
    if (los && !(await ctx.bevestig('Verder met je nieuwe bericht?', 'Je was bezig met "' + (los.b.titel || 'een bericht zonder titel') + '" en dat is nog niet opgeslagen.', 'Verder schrijven'))) {
      try { localStorage.removeItem(KLAD(los.b.id)); } catch (e) {}
      los = null;
    }
    var b = schoon(bestaand || (los ? Object.assign(leeg(), { id: los.b.id }) : leeg()));
    ed = { b: b, orig: JSON.stringify(b), nieuw: !bestaand, pad: bestaand ? bestaand._pad : 'berichten/' + b.id + '.json', sha: bestaand ? bestaand._sha : null,
      slugVrij: !bestaand || (!b.slug || b.slug === maakSlug(b.titel)) && soort(b) === 'concept', wanneer: b.publicatie && soort(b) === 'ingepland' ? 'later' : 'nu', voorbeeld: false };
    if (soort(b) === 'concept' && achteraan()) ed.wanneer = 'rij';   // staat er al iets in de planning, dan standaard daarachter
    var klad = null; try { klad = JSON.parse(localStorage.getItem(KLAD(b.id)) || 'null'); } catch (e) {}
    if (los) ed.b = schoon(los.b);
    else if (klad && klad.b && JSON.stringify(schoon(klad.b)) !== ed.orig && klad.tijd > Date.parse(b.gewijzigd || 0)) {
      var terug = await ctx.bevestig('Niet-opgeslagen wijzigingen terugzetten?', 'Je was op ' + new Date(klad.tijd).toLocaleString('nl-NL', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) + ' met dit bericht bezig en dat is nog niet opgeslagen.', 'Terugzetten');
      if (terug) ed.b = schoon(klad.b); else try { localStorage.removeItem(KLAD(b.id)); } catch (e) {}
    }
    var el = $('neditor');
    if (!el) { el = document.createElement('div'); el.id = 'neditor'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Bericht bewerken'); document.body.appendChild(el); }
    el.classList.remove('verborgen'); document.body.style.overflow = 'hidden';
    tekenEditor();
  }
  async function sluitEditor() {
    if (gewijzigd() && !(await ctx.bevestig('Wijzigingen niet opgeslagen', 'Je wijzigingen staan nog niet in de opslag. Op dit toestel blijft een kladversie bewaard, die je terugkrijgt als je het bericht weer opent.', 'Toch sluiten'))) return;
    $('neditor').classList.add('verborgen'); $('neditor').innerHTML = ''; document.body.style.overflow = ''; ed = null; tekenLijst();
  }

  function tekenEditor() {
    var b = ed.b, s = soort(b), dv = b.publicatie ? datumVeld(b.publicatie) : datumVeld(new Date(Date.now() + 864e5).toISOString());
    if (!b.publicatie) { dv.tijd = '09:00'; }
    var teller = function (id, max) { return '<small class="ne-teller" id="' + id + '" data-max="' + max + '"></small>'; };
    var opties = RUBRIEKEN.concat(RUBRIEKEN.indexOf(b.rubriek) === -1 && b.rubriek ? [b.rubriek] : []).map(function (r) { return '<option' + (r === b.rubriek ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('');
    $('neditor').innerHTML =
      '<div class="ne-balk"><div class="ne-balk-in"><button class="ne-terug" type="button" id="ne-sluit" aria-label="Terug naar de berichten">← <span>Berichten</span></button><span id="ne-pil">' + pil(b) + '</span>' +
      '<span class="ne-bewaard" id="ne-bewaard"></span><button class="knop licht" type="button" id="ne-vb">' + (ed.voorbeeld ? 'Bewerken' : 'Voorbeeld') + '</button><button class="knop" type="button" id="ne-opslaan">Opslaan</button></div></div>' +
      '<div class="ne-grid"><div id="ne-hoofd">' +
        '<div class="ne-vak" id="ne-velden"' + (ed.voorbeeld ? ' hidden' : '') + '>' +
          '<div class="ne-veld ne-titel"><label for="ne-titel">Titel ' + teller('t-titel', 75) + '</label><input id="ne-titel" data-v="titel" value="' + esc(b.titel) + '" placeholder="Waar gaat het bericht over?"></div>' +
          '<div class="ne-veld"><label for="ne-slug">Webadres</label><div class="ne-slug"><span>ais-groep.nl/nieuws/</span><input id="ne-slug" data-v="slug" value="' + esc(b.slug) + '" spellcheck="false" autocapitalize="off"></div><p class="ne-hint" id="ne-slughint"></p></div>' +
          '<div class="ne-veld"><label for="ne-samenvatting">Korte samenvatting ' + teller('t-sam', 180) + '</label><textarea id="ne-samenvatting" data-v="samenvatting" rows="2" placeholder="Eén of twee zinnen: wat heeft de lezer eraan? Staat op het kaartje bij Nieuws.">' + esc(b.samenvatting) + '</textarea></div>' +
          '<div class="ne-twee"><div class="ne-veld"><label for="ne-rubriek">Rubriek</label><select id="ne-rubriek" data-v="rubriek">' + opties + '</select></div>' +
          '<div class="ne-veld"><label for="ne-auteur">Schrijver</label><input id="ne-auteur" data-v="auteur" value="' + esc(b.auteur) + '" list="ne-auteurs"><datalist id="ne-auteurs"><option value="AIS-Groep"><option value="Achmed Afkiri"></datalist></div></div>' +
          '<div class="ne-veld"><span class="ne-label">Omslagfoto <small>' + FOTOMAAT.toLowerCase() + ', onderwerp in het midden</small></span><div class="ne-beeld"><div class="ne-beeld-vb" id="ne-beeldvb">' + leegVak('Nog geen foto') + '</div><div>' +
            '<div class="ne-beeld-knoppen"><label class="knop licht" style="cursor:pointer">Foto kiezen<input type="file" id="ne-bestand" accept="image/*" hidden></label>' + (b.beeld ? '<button class="knop licht" type="button" id="ne-geenbeeld">Weghalen</button>' : '') + '</div>' +
            '<input id="ne-alt" data-v="beeldAlt" value="' + esc(b.beeldAlt) + '" placeholder="Wat staat er op de foto? (voor Google en schermlezers)" aria-label="Beschrijving van de foto"></div></div></div>' +
          '<div class="ne-veld"><span class="ne-label">In het kort <small>optioneel, max. 3 punten bovenaan het artikel</small></span><div class="ne-kort">' +
            [0, 1, 2].map(function (i) { return '<input data-kort="' + i + '" value="' + esc(b.kort[i]) + '" placeholder="Punt ' + (i + 1) + '" aria-label="In het kort, punt ' + (i + 1) + '">'; }).join('') + '</div></div>' +
          '<div class="ne-veld"><span class="ne-label"><span>Tekst</span><small id="ne-woorden"></small></span>' +
            '<div class="ne-gereedschap" role="toolbar" aria-label="Opmaak">' + [['h2', 'Tussenkop', 'Tussenkop'], ['h3', 'Kleine kop', 'Kleine kop'], ['vet', '<b>B</b>', 'Vet (⌘B)'], ['schuin', '<em>I</em>', 'Schuin (⌘I)'],
              ['link', 'Link', 'Link (⌘K)'], ['lijst', '• Lijst', 'Opsomming'], ['nummer', '1. Lijst', 'Genummerde lijst'], ['citaat', '“ Citaat', 'Citaat']]
              .map(function (k) { return '<button type="button" data-md="' + k[0] + '" title="' + k[2] + '" aria-pressed="false">' + k[1] + '</button>'; }).join('') + '</div>' +
            '<div id="ne-tekst" class="ne-wysiwyg" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Tekst van het bericht" data-leeg="Begin met een korte inleiding. Kies daarna Tussenkop voor een nieuw kopje."></div>' +
            '<p class="ne-uitleg">Selecteer tekst en kies een knop. Enter begint een nieuwe alinea. Plakken uit Word of Google Docs mag: koppen, vet, lijsten en links gaan mee.</p></div>' +
          '<div class="ne-twee"><div class="ne-veld"><label for="ne-seot">SEO-titel ' + teller('t-seot', 60) + '</label><input id="ne-seot" data-v="seoTitel" value="' + esc(b.seoTitel) + '" placeholder="Leeg = de titel"></div>' +
          '<div class="ne-veld"><label for="ne-seob">SEO-omschrijving ' + teller('t-seob', 160) + '</label><input id="ne-seob" data-v="seoBeschrijving" value="' + esc(b.seoBeschrijving) + '" placeholder="Leeg = de samenvatting"></div></div>' +
        '</div>' +
        '<div id="ne-voorbeeld"' + (ed.voorbeeld ? '' : ' hidden') + '></div>' +
      '</div>' +
      '<aside class="ne-zij">' +
        '<div class="ne-vak"><h4>Publicatie</h4><div id="ne-pub"></div></div>' +
        '<div class="ne-vak"><h4>SEO-controle</h4><div id="ne-seo"></div><div class="ne-google" id="ne-google"></div></div>' +
        '<div class="ne-vak ne-deel"><h4>Delen op LinkedIn en WhatsApp</h4><canvas id="ne-deel" width="1200" height="630" aria-label="Voorbeeld van de deelafbeelding"></canvas>' +
          '<div class="seg" id="ne-deelstijl"><button data-ds="foto"' + (b.deelStijl !== 'rustig' ? ' class="aan"' : '') + '>Met foto</button><button data-ds="rustig"' + (b.deelStijl === 'rustig' ? ' class="aan"' : '') + '>Rustig</button></div>' +
          '<p class="ne-hint" style="margin-top:8px">Deze afbeelding wordt automatisch gemaakt bij publiceren of inplannen.</p></div>' +
        '<div class="ne-vak"><h4>Overig</h4><div class="ne-acties" id="ne-overig"></div></div>' +
      '</aside></div>';
    ed.datum = ed.datum || dv.datum; ed.tijd = ed.tijd || dv.tijd;
    koppelEditor(); werkBij(); tekenPub(); tekenOverig(); toonBeeld(); if (ed.voorbeeld) tekenVoorbeeld();
  }

  function koppelEditor() {
    var el = $('neditor');
    el.querySelectorAll('[data-v]').forEach(function (v) {
      v.addEventListener('input', function () {
        ed.b[v.dataset.v] = v.value;
        if (v.dataset.v === 'titel' && ed.slugVrij) { ed.b.slug = maakSlug(v.value); $('ne-slug').value = ed.b.slug; }
        if (v.dataset.v === 'slug') { ed.slugVrij = false; }
        werkBij();
      });
    });
    $('ne-slug').addEventListener('blur', function () { ed.b.slug = maakSlug(this.value); this.value = ed.b.slug; werkBij(); });
    el.querySelectorAll('[data-kort]').forEach(function (v) { v.addEventListener('input', function () { ed.b.kort[+v.dataset.kort] = v.value; werkBij(); }); });
    $('ne-sluit').onclick = sluitEditor;
    $('ne-opslaan').onclick = function () { opslaan(null); };
    $('ne-vb').onclick = function () { ed.voorbeeld = !ed.voorbeeld; $('ne-velden').hidden = ed.voorbeeld; $('ne-voorbeeld').hidden = !ed.voorbeeld; this.textContent = ed.voorbeeld ? 'Bewerken' : 'Voorbeeld'; if (ed.voorbeeld) tekenVoorbeeld(); window.scrollTo(0, 0); $('neditor').scrollTop = 0; };
    $('ne-bestand').onchange = function () { if (this.files[0]) kiesBeeld(this.files[0]); this.value = ''; };
    if ($('ne-geenbeeld')) $('ne-geenbeeld').onclick = function () { ed.b.beeld = ''; tekenEditor(); };
    $('ne-deelstijl').onclick = function (e) { var k = e.target.closest('button'); if (!k) return; ed.b.deelStijl = k.dataset.ds; this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('aan', x === k); }); werkBij(); };
    var balk = el.querySelector('.ne-gereedschap'), vlak = $('ne-tekst');
    balk.addEventListener('mousedown', function (e) { if (e.target.closest('[data-md]')) e.preventDefault(); });   // selectie in de tekst laten staan
    balk.onclick = function (e) { var k = e.target.closest('[data-md]'); if (k) opmaak(k.dataset.md); };
    vlak.innerHTML = md(ed.b.tekst).html || '<p><br></p>';
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); document.execCommand('styleWithCSS', false, false); } catch (e) {}
    var tekstUit = function () { ed.b.tekst = htmlNaarMd(vlak); vlak.classList.toggle('is-leeg', !vlak.textContent.trim() && !vlak.querySelector('li')); werkBij(); };
    vlak.classList.toggle('is-leeg', !vlak.textContent.trim());
    vlak.addEventListener('input', tekstUit);
    vlak.addEventListener('keydown', function (e) {
      var k = (e.metaKey || e.ctrlKey) && e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); opmaak('vet'); } else if (k === 'i') { e.preventDefault(); opmaak('schuin'); } else if (k === 'k') { e.preventDefault(); opmaak('link'); }
    });
    // plakken: alleen wat de site ook kent (koppen, vet, schuin, links, lijsten, citaat); de rest valt weg
    vlak.addEventListener('paste', function (e) {
      var d = e.clipboardData; if (!d) return;
      e.preventDefault();
      var h = d.getData('text/html'), mdTekst;
      if (h) { var tijdelijk = document.createElement('div'); tijdelijk.innerHTML = h.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script|meta|title)[\s\S]*?<\/\1>/gi, ''); mdTekst = htmlNaarMd(tijdelijk); }
      else mdTekst = (d.getData('text/plain') || '').replace(/\r/g, '').split(/\n{2,}/).map(function (a) { return a.replace(/\n/g, ' '); }).join('\n\n');
      var r = md(mdTekst).html.replace(/\n/g, '');
      if (/^<p>[^]*<\/p>$/.test(r) && r.indexOf('</p>') === r.length - 4) r = r.slice(3, -4);   // één alinea: midden in de zin plakken
      document.execCommand('insertHTML', false, r.replace(/ id="h-[^"]*"/g, ''));
    });
    document.addEventListener('selectionchange', knopStand);
  }
  // knoppen tonen of vet, een kop of een lijst aan staat op de plek van de cursor
  function knopStand() {
    var vlak = $('ne-tekst'), sel = window.getSelection(); if (!vlak || !sel.rangeCount || !vlak.contains(sel.anchorNode)) return;
    var n = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode, binnen = function (tags) { for (var x = n; x && x !== vlak; x = x.parentNode) if (tags.indexOf(x.nodeName) !== -1) return true; return false; };
    var stand = { h2: binnen(['H2']), h3: binnen(['H3']), vet: binnen(['B', 'STRONG']), schuin: binnen(['I', 'EM']), link: binnen(['A']), lijst: binnen(['UL']), nummer: binnen(['OL']), citaat: binnen(['BLOCKQUOTE']) };
    document.querySelectorAll('.ne-gereedschap [data-md]').forEach(function (k) { k.setAttribute('aria-pressed', stand[k.dataset.md] ? 'true' : 'false'); });
  }
  // de tekst in het bewerkvlak terug naar de opgeslagen vorm (dezelfde regels als md(), zodat heen en terug niets verandert)
  function htmlNaarMd(root) {
    var regel = function (node) {   // inline-inhoud van een blok
      var uit = '';
      node.childNodes.forEach(function (c) {
        if (c.nodeType === 3) { uit += c.nodeValue.replace(/\s+/g, ' '); return; }
        if (c.nodeType !== 1) return;
        var t = c.nodeName, binnen = regel(c);
        var vet = ((t === 'B' || t === 'STRONG') && !/normal|[1-4]00/.test(c.style.fontWeight)) || (t === 'SPAN' && /bold|[6-9]00/.test(c.style.fontWeight));   // Google Docs: <b style="font-weight:normal"> is niet vet
        if (t === 'BR') uit += ' ';
        else if (t === 'UL' || t === 'OL') { /* een lijst in een lijst: die punten komen apart mee */ }
        else if (vet && binnen.trim()) uit += vast(binnen, '**');
        else if ((t === 'I' || t === 'EM' || (t === 'SPAN' && c.style.fontStyle === 'italic')) && binnen.trim()) uit += vast(binnen, '*');
        else if (t === 'A' && c.getAttribute('href') && binnen.trim()) uit += '[' + binnen.trim() + '](' + netteLink(c.getAttribute('href')) + ')';
        else uit += binnen;
      });
      return uit;
    };
    var vast = function (t, teken) { var m = t.match(/^(\s*)([^]*?)(\s*)$/); return m[1] + teken + m[2] + teken + m[3]; };   // **vet** zonder spaties aan de binnenkant
    var blokken = [], losseRegel = '';
    var spoel = function () { var t = losseRegel.replace(/\s+/g, ' ').trim(); if (t) blokken.push(t); losseRegel = ''; };
    var BLOK = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|SECTION|ARTICLE|HEADER|FOOTER|TABLE|TR|PRE)$/;
    var loop = function (node) {
      node.childNodes.forEach(function (c) {
        if (c.nodeType === 1 && !BLOK.test(c.nodeName) && c.querySelector('p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,table')) { spoel(); loop(c); return; }   // bijv. de <b> om een hele Google Docs-tekst
        if (c.nodeType === 3 || (c.nodeType === 1 && !BLOK.test(c.nodeName))) { if (c.nodeName === 'BR') { spoel(); return; } losseRegel += c.nodeType === 3 ? c.nodeValue : regel({ childNodes: [c] }); return; }
        if (c.nodeType !== 1) return;
        spoel();
        var t = c.nodeName, tekst = function () { return regel(c).replace(/\s+/g, ' ').trim(); };
        if (t === 'H1' || t === 'H2') { if (tekst()) blokken.push('## ' + tekst().replace(/^\*\*(.*)\*\*$/, '$1')); }
        else if (/^H[3-6]$/.test(t)) { if (tekst()) blokken.push('### ' + tekst().replace(/^\*\*(.*)\*\*$/, '$1')); }
        else if (t === 'UL' || t === 'OL') {
          var items = [], n = 0;
          c.querySelectorAll('li').forEach(function (li) { var x = regel(li).replace(/\s+/g, ' ').trim(); if (x) items.push((t === 'OL' ? (++n) + '. ' : '- ') + x); });
          if (items.length) blokken.push(items.join('\n'));
        }
        else if (t === 'BLOCKQUOTE') { var q = c.textContent.replace(/\s+/g, ' ').trim() ? regel(c).replace(/\s+/g, ' ').trim() : ''; if (q) blokken.push('> ' + q); }
        else if ((t === 'P' || t === 'LI' || t === 'PRE') && c.querySelector('ul,ol,h1,h2,h3,h4,h5,h6,blockquote,p,div')) loop(c);   // de browser zet een lijst soms ín een alinea
        else if (t === 'P' || t === 'LI' || t === 'PRE') {
          // een <br> midden in een alinea wordt een nieuwe alinea (zo werkt het op de site ook)
          var delen = c.innerHTML.split(/<br\s*\/?>/i);
          delen.forEach(function (d) { var x = document.createElement('div'); x.innerHTML = d; var y = regel(x).replace(/\s+/g, ' ').trim(); if (y) blokken.push(y); });
        }
        else loop(c);   // div, section, tabel: kijk erin
      });
    };
    loop(root); spoel();
    return blokken.join('\n\n');
  }
  function netteLink(href) {   // links naar de eigen site kort houden (/promesse/ in plaats van https://www.ais-groep.nl/promesse/)
    return String(href).trim().replace(/^https?:\/\/(www\.)?ais-groep\.nl(?=\/)/i, '');
  }
  function opmaak(soortOp) {
    var vlak = $('ne-tekst'); vlak.focus();
    var sel = window.getSelection(), n = sel.rangeCount ? sel.anchorNode : null; if (n && n.nodeType === 3) n = n.parentNode;
    var blok = function (tag) { for (var x = n; x && x !== vlak; x = x.parentNode) if (x.nodeName === tag) return x; return null; };
    if (soortOp === 'vet') document.execCommand('bold');
    else if (soortOp === 'schuin') document.execCommand('italic');
    else if (soortOp === 'h2' || soortOp === 'h3' || soortOp === 'citaat') {
      var tag = soortOp === 'citaat' ? 'BLOCKQUOTE' : soortOp.toUpperCase();
      if (blok('UL') || blok('OL')) document.execCommand(blok('UL') ? 'insertUnorderedList' : 'insertOrderedList');   // eerst uit de lijst
      document.execCommand('formatBlock', false, blok(tag) ? '<p>' : '<' + tag.toLowerCase() + '>');
    }
    else if (soortOp === 'lijst' || soortOp === 'nummer') {
      if (blok('H2') || blok('H3') || blok('BLOCKQUOTE')) document.execCommand('formatBlock', false, '<p>');
      document.execCommand(soortOp === 'lijst' ? 'insertUnorderedList' : 'insertOrderedList');
    }
    else if (soortOp === 'link') {
      var a = blok('A');
      if (!a && sel.isCollapsed) { ctx.toast('Selecteer eerst de woorden die de link moeten worden.'); return; }
      var bewaard = sel.getRangeAt(0).cloneRange();
      var url = window.prompt(a ? 'Waar gaat de link heen? Maak het vak leeg om de link weg te halen.' : 'Naar welke pagina linkt het? Bijvoorbeeld /promesse/ of https://…', a ? a.getAttribute('href') : '/');
      vlak.focus(); sel.removeAllRanges(); sel.addRange(bewaard);
      if (url === null) return;
      url = netteLink(url);
      if (a && !url) { var r = document.createRange(); r.selectNodeContents(a); sel.removeAllRanges(); sel.addRange(r); document.execCommand('unlink'); }
      else if (url && !/^(https?:\/\/|\/|#|mailto:|tel:)/.test(url)) { url = /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url) ? 'https://' + url : '/' + url.replace(/^\/+/, ''); }
      if (url && a) a.setAttribute('href', url); else if (url) document.execCommand('createLink', false, url);
    }
    vlak.dispatchEvent(new Event('input')); knopStand();
  }

  var kladTimer = null, deelTimer = null;
  function werkBij() {
    var b = ed.b;
    [['t-titel', b.titel], ['t-sam', b.samenvatting], ['t-seot', googleTitel(b)], ['t-seob', googleOms(b)]].forEach(function (x) {
      var el = $(x[0]); if (!el) return; var max = +el.dataset.max, n = (x[1] || '').length;
      el.textContent = n + ' / ' + max; el.classList.toggle('te-lang', n > max);
    });
    $('ne-woorden').textContent = woorden(b.tekst) + ' woorden · ' + Math.max(1, Math.round(woorden(b.tekst) / 200)) + ' min lezen';
    // webadres: uniek, en waarschuwen als een gepubliceerd bericht van adres verandert
    var dubbel = VASTE_ADRESSEN.indexOf(b.slug) !== -1 || berichten.some(function (x) { return x.id !== b.id && x.status !== 'prullenbak' && x.slug === b.slug; });
    var origSlug = JSON.parse(ed.orig).slug, live = soort(JSON.parse(ed.orig)) === 'gepubliceerd';
    var hint = $('ne-slughint');
    hint.className = 'ne-hint' + (dubbel || (live && b.slug !== origSlug) ? ' let' : '');
    hint.textContent = !b.slug ? 'Wordt gemaakt uit de titel.' : dubbel ? 'Dit adres bestaat al. Kies een ander adres.'
      : live && b.slug !== origSlug ? 'Dit bericht staat al online. Het oude adres (/nieuws/' + origSlug + '/) verwijst straks vanzelf door naar het nieuwe.'
      : ed.slugVrij ? 'Gaat vanzelf mee met de titel. Pas het aan als je een korter adres wilt.' : '';
    // SEO
    var r = seo(b);
    $('ne-seo').innerHTML = '<div class="ne-seo-kop"><span class="n-score ' + scoreKlas(r.score) + '">' + r.score + '</span><p>' + (r.score >= 80 ? 'Goed op orde.' : r.score >= GRENS ? 'Bijna: kijk nog even naar de punten met een uitroepteken.' : 'Nog niet klaar voor publicatie. Onder ' + GRENS + ' vraagt het dashboard of je het zeker weet.') + ' Dit is een eigen checklist, geen Google-score.</p></div>' +
      '<ul class="ne-check">' + r.punten.slice().sort(function (x, y) { return x.ok - y.ok; }).map(function (p) { return '<li class="' + (p.ok ? '' : 'mis') + '">' + esc(p.tekst) + '</li>'; }).join('') + '</ul>';
    var gt = googleTitel(b), go = googleOms(b);
    $('ne-google').innerHTML = '<div class="g-url"><i></i><span>AIS-Groep<br><small style="color:#4d5156">https://www.ais-groep.nl › nieuws › ' + esc(b.slug || '…') + '</small></span></div>' +
      '<div class="g-titel">' + esc(gt.length > 62 ? gt.slice(0, 60) + '…' : gt) + '</div><div class="g-oms">' + esc(go.length > 160 ? go.slice(0, 157) + '…' : go || 'Vul een samenvatting in, anders kiest Google zelf een stukje tekst.') + '</div>';
    var pl = $('ne-pil'); if (pl) pl.innerHTML = pil(b);
    $('ne-bewaard').textContent = gewijzigd() ? 'Niet opgeslagen' : ed.nieuw ? '' : 'Opgeslagen';
    clearTimeout(kladTimer); kladTimer = setTimeout(function () { if (ed && gewijzigd()) try { localStorage.setItem(KLAD(b.id), JSON.stringify({ b: b, tijd: Date.now() })); } catch (e) {} }, 700);
    clearTimeout(deelTimer); deelTimer = setTimeout(function () { tekenDeel($('ne-deel')).catch(function () {}); }, 250);
  }

  function achteraan() {
    var laatste = berichten.filter(function (x) { return x.id !== ed.b.id && soort(x) === 'ingepland'; }).map(function (x) { return x.publicatie; })
      .sort(function (a, c) { return Date.parse(c) - Date.parse(a); })[0];
    if (!laatste) return null;
    var d = datumVeld(laatste), dag = new Date(Date.UTC(+d.datum.slice(0, 4), +d.datum.slice(5, 7) - 1, +d.datum.slice(8, 10)) + 7 * 864e5).toISOString().slice(0, 10);
    return isoUit(dag, d.tijd);
  }
  function tekenPub() {
    var b = ed.b, s = soort(JSON.parse(ed.orig)), h = '', rij = achteraan();
    if (ed.wanneer === 'rij' && !rij) ed.wanneer = 'nu';
    var keuze = '<div class="ne-wanneer"><label><input type="radio" name="ne-w" value="nu"' + (ed.wanneer === 'nu' ? ' checked' : '') + '> Direct publiceren</label>' +
      (rij && s === 'concept' ? '<label><input type="radio" name="ne-w" value="rij"' + (ed.wanneer === 'rij' ? ' checked' : '') + '> Achteraan in de planning <small style="color:var(--muted)">(' + esc(toonTijd(rij)) + ')</small></label>' : '') +
      '<label><input type="radio" name="ne-w" value="later"' + (ed.wanneer === 'later' ? ' checked' : '') + '> Inplannen op</label>' +
      '<div class="ne-datum"' + (ed.wanneer === 'later' ? '' : ' hidden') + '><input type="date" id="ne-datum" value="' + ed.datum + '" aria-label="Datum"><input type="time" id="ne-tijd" value="' + ed.tijd + '" step="300" aria-label="Tijd"></div>' +
      '<p class="ne-hint" style="margin-left:25px"' + (ed.wanneer === 'later' ? '' : ' hidden') + ' id="ne-tzhint">Nederlandse tijd. Het bericht komt online bij de eerstvolgende bijwerkronde van de site (binnen ongeveer 5 minuten).</p></div>';
    if (s === 'concept') {
      h = '<p class="ne-stand">Dit bericht is een <b>concept</b>. Alleen jij ziet het.</p>' + keuze + '<div class="ne-acties"><button class="knop" type="button" id="ne-publiceer">' + (ed.wanneer === 'nu' ? 'Publiceren' : 'Inplannen') + '</button></div>';
    } else if (s === 'ingepland') {
      h = '<p class="ne-stand">Ingepland: gaat online op <b>' + esc(toonTijd(b.publicatie)) + '</b>.</p>' + keuze.replace('Direct publiceren', 'Nu publiceren').replace('Inplannen op', 'Ander moment') +
        '<div class="ne-acties"><button class="knop" type="button" id="ne-publiceer">' + (ed.wanneer === 'later' ? 'Moment opslaan' : 'Nu publiceren') + '</button><button class="knop licht" type="button" id="ne-concept">Planning stoppen (terug naar concept)</button></div>';
    } else if (s === 'gepubliceerd') {
      h = '<p class="ne-stand">Gepubliceerd op <b>' + esc(toonTijd(b.publicatie)) + '</b>. Wijzigingen gaan online zodra je op <b>Opslaan</b> klikt.</p>' +
        '<div class="ne-acties"><button class="knop licht" type="button" id="ne-concept">Offline halen (terug naar concept)</button></div>';
    } else {
      h = '<p class="ne-stand">Dit bericht staat in de <b>prullenbak</b> en is niet zichtbaar op de site.</p><div class="ne-acties"><button class="knop" type="button" id="ne-terugzet">Terugzetten als concept</button><button class="knop rood" type="button" id="ne-definitief">Definitief verwijderen</button></div>';
    }
    $('ne-pub').innerHTML = h;
    $('ne-pub').querySelectorAll('input[name=ne-w]').forEach(function (r) { r.onchange = function () { ed.wanneer = r.value; tekenPub(); }; });
    if ($('ne-datum')) { $('ne-datum').onchange = function () { ed.datum = this.value; }; $('ne-tijd').onchange = function () { ed.tijd = this.value; }; }
    if ($('ne-publiceer')) $('ne-publiceer').onclick = publiceer;
    if ($('ne-concept')) $('ne-concept').onclick = async function () {
      var live = s === 'gepubliceerd';
      if (!(await ctx.bevestig(live ? 'Offline halen?' : 'Planning stoppen?', live ? 'Het bericht verdwijnt bij de volgende bijwerkronde van de site en wordt weer een concept. Wie de link al heeft, krijgt dan een "niet gevonden".' : 'Het bericht wordt weer een concept en gaat niet online.', live ? 'Offline halen' : 'Planning stoppen'))) return;
      ed.b.status = 'concept'; opslaan(live ? 'offline gehaald' : 'planning gestopt');
    };
    if ($('ne-terugzet')) $('ne-terugzet').onclick = function () { ed.b.status = 'concept'; opslaan('teruggezet uit de prullenbak'); };
    if ($('ne-definitief')) $('ne-definitief').onclick = verwijderDefinitief;
  }
  function tekenOverig() {
    var s = soort(JSON.parse(ed.orig));
    $('ne-overig').innerHTML = (s !== 'prullenbak' && !ed.nieuw ? '<button class="knop rood" type="button" id="ne-weg">Naar de prullenbak</button>' : '') +
      '<p class="ne-hint">Elke opgeslagen versie blijft bewaard in de geschiedenis van de opslag. Zonder opslaan houdt dit toestel een kladversie bij.</p>';
    if ($('ne-weg')) $('ne-weg').onclick = async function () {
      if (!(await ctx.bevestig('Naar de prullenbak?', s === 'gepubliceerd' ? 'Het bericht gaat offline bij de volgende bijwerkronde van de site. Je kunt het later terugzetten.' : 'Je kunt het later terugzetten vanuit de prullenbak.', 'Naar de prullenbak'))) return;
      ed.b.status = 'prullenbak'; opslaan('naar de prullenbak');
    };
  }

  async function publiceer() {
    var b = ed.b, later = ed.wanneer !== 'nu';
    if (!b.titel.trim()) { ctx.toast('Geef het bericht eerst een titel.'); $('ne-titel').focus(); return; }
    if (!b.tekst.trim()) { ctx.toast('Er staat nog geen tekst in het bericht.'); return; }
    var iso = ed.wanneer === 'rij' ? achteraan() : later ? isoUit(ed.datum, ed.tijd) : nuIso();
    if (later && Date.parse(iso) <= Date.now() + 60000) { ctx.toast('Kies een moment in de toekomst, of kies Direct publiceren.'); return; }
    var r = seo(b);
    if (r.score < GRENS && !(await ctx.bevestig('SEO-controle: ' + r.score + ' van 100', 'Nog niet alles staat goed (zie de punten met een uitroepteken). Wil je het bericht toch ' + (later ? 'inplannen' : 'publiceren') + '?', later ? 'Toch inplannen' : 'Toch publiceren'))) return;
    b.status = 'klaar'; b.publicatie = iso;
    await opslaan(later ? 'ingepland voor ' + toonTijd(iso) : 'gepubliceerd');
  }

  async function opslaan(wat) {
    var b = ed.b, knop = $('ne-opslaan');
    if (!b.titel.trim()) { ctx.toast('Geef het bericht eerst een titel.'); return; }
    b.slug = maakSlug(b.slug || b.titel);
    if (!b.slug) { ctx.toast('Het webadres is leeg. Vul een titel of adres in.'); return; }
    if (VASTE_ADRESSEN.indexOf(b.slug) !== -1 || berichten.some(function (x) { return x.id !== b.id && x.status !== 'prullenbak' && x.slug === b.slug; })) { ctx.toast('Dit webadres bestaat al. Kies een ander adres.'); return; }
    var orig = JSON.parse(ed.orig);
    if (soort(orig) === 'gepubliceerd' && orig.slug && orig.slug !== b.slug && b.oudeSlugs.indexOf(orig.slug) === -1) b.oudeSlugs = b.oudeSlugs.concat([orig.slug]);
    if (!wat && !gewijzigd()) { ctx.toast('Er is niets veranderd.'); return; }
    knop.disabled = true; knop.textContent = 'Opslaan…';
    try {
      b.gewijzigd = nuIso();
      // deelafbeelding maken zodra het bericht online gaat; daarna alleen opnieuw als titel, rubriek, foto of stijl verandert
      var deelSleutel = function (x) { return [x.titel, x.rubriek, x.beeld, x.deelStijl].join('|'); };
      if (b.status === 'klaar' && (!b.deelbeeld || deelSleutel(b) !== deelSleutel(orig))) {
        var canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 630; await tekenDeel(canvas);
        var deelB64 = canvas.toDataURL('image/jpeg', 0.86).split(',')[1], deelPad = 'beelden/deel-' + b.id + '.jpg';
        bestandSha[deelPad] = await opslag.schrijf(deelPad, deelB64, bestandSha[deelPad], 'Deelafbeelding: ' + b.titel);
        b.deelbeeld = deelPad;
      }
      var inhoud = JSON.stringify(schoon(b), null, 2) + '\n';
      ed.sha = await opslag.schrijf(ed.pad, naarB64(inhoud), ed.sha, 'Nieuws: ' + b.titel + ' (' + (wat || 'opgeslagen') + ')');
      bestandSha[ed.pad] = ed.sha;
      var kopie = schoon(b); kopie._pad = ed.pad; kopie._sha = ed.sha;
      var i = berichten.findIndex(function (x) { return x.id === b.id; }); if (i === -1) berichten.push(kopie); else berichten[i] = kopie;
      ed.orig = JSON.stringify(schoon(b)); ed.nieuw = false; ed.slugVrij = ed.slugVrij && soort(b) === 'concept';
      try { localStorage.removeItem(KLAD(b.id)); } catch (e) {}
      ctx.toast(wat === 'gepubliceerd' ? 'Gepubliceerd. Het bericht komt online bij de volgende bijwerkronde van de site.' : wat ? 'Bericht ' + wat + '.' : 'Opgeslagen.');
      if (b.status === 'prullenbak') { $('neditor').classList.add('verborgen'); $('neditor').innerHTML = ''; document.body.style.overflow = ''; ed = null; tekenLijst(); return; }
      tekenEditor();
    } catch (e) {
      b.status = JSON.parse(ed.orig).status; b.publicatie = JSON.parse(ed.orig).publicatie;
      knop.disabled = false; knop.textContent = 'Opslaan';
      if (e && e.soort === 'conflict' && await ctx.bevestig('Intussen ergens anders gewijzigd', 'Dit bericht is na het openen op een ander toestel opgeslagen. Wil je jouw versie daaroverheen zetten? De andere versie blijft in de geschiedenis staan.', 'Mijn versie opslaan')) {
        try { var lijst = await opslag.lijst(); var x = lijst.find(function (y) { return y.pad === ed.pad; }); ed.sha = x ? x.sha : null; return opslaan(wat); } catch (e2) { fout(e2); return; }
      }
      fout(e);
    }
  }
  async function verwijderDefinitief() {
    if (!(await ctx.bevestig('Definitief verwijderen?', 'Het bericht verdwijnt uit het dashboard. In de geschiedenis van de opslag op GitHub blijft het nog terug te vinden.', 'Verwijderen'))) return;
    try {
      await opslag.wis(ed.pad, ed.sha, 'Nieuws: ' + ed.b.titel + ' (definitief verwijderd)');
      berichten = berichten.filter(function (x) { return x.id !== ed.b.id; });
      try { localStorage.removeItem(KLAD(ed.b.id)); } catch (e) {}
      $('neditor').classList.add('verborgen'); $('neditor').innerHTML = ''; document.body.style.overflow = ''; ed = null; tekenLijst(); ctx.toast('Verwijderd.');
    } catch (e) { fout(e); }
  }

  // ---- foto's -----------------------------------------------------------------------------------------------------
  async function kiesBeeld(bestand) {
    if (!/^image\//.test(bestand.type)) { ctx.toast('Kies een foto (jpg, png of heic).'); return; }
    try {
      var img = await laadPlaatje(URL.createObjectURL(bestand)), max = 1600, w = img.naturalWidth, h = img.naturalHeight;
      if (w > max) { h = Math.round(h * max / w); w = max; }
      var c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
      var b64 = c.toDataURL('image/jpeg', 0.84).split(',')[1], pad = 'beelden/' + (ed.b.slug || 'bericht') + '-' + Math.random().toString(36).slice(2, 6) + '.jpg';
      $('ne-beeldvb').textContent = 'Uploaden…';
      bestandSha[pad] = await opslag.schrijf(pad, b64, null, 'Foto: ' + (ed.b.titel || pad));
      beeldUrl[pad] = c.toDataURL('image/jpeg', 0.84);
      ed.b.beeld = pad;
      var klein = img.naturalWidth < 1200 || img.naturalHeight < 750, staand = img.naturalHeight > img.naturalWidth;
      if (klein || staand) ctx.toast('Foto toegevoegd, maar ' + (staand ? 'hij staat rechtop: op de site wordt boven en onder veel weggesneden' : 'hij is klein (' + img.naturalWidth + ' × ' + img.naturalHeight + ') en kan wazig worden') + '. Het best: ' + FOTOMAAT.toLowerCase() + '.');
      else if (!ed.b.beeldAlt) ctx.toast('Foto toegevoegd. Beschrijf er nog kort bij wat erop staat.');
      tekenEditor();
    } catch (e) { $('ne-beeldvb').textContent = 'Uploaden lukte niet'; fout(e); }
  }
  function leegVak(tekst) { return '<span>' + esc(tekst) + '<small class="ne-maat">' + esc(FOTOMAAT) + '</small></span>'; }
  function laadPlaatje(src) { return new Promise(function (ok, mis) { var i = new Image(); i.onload = function () { ok(i); }; i.onerror = mis; i.src = src; }); }
  function toonBeeld() {
    var vb = $('ne-beeldvb'); if (!vb) return;
    if (!ed.b.beeld) { vb.innerHTML = leegVak('Nog geen foto'); vb.style.backgroundImage = ''; return; }
    vb.textContent = 'Laden…';
    beeld(ed.b.beeld).then(function (u) { if (!$('ne-beeldvb')) return; if (u) { vb.style.backgroundImage = 'url(' + u + ')'; vb.textContent = ''; } else vb.innerHTML = leegVak('Foto niet gevonden. Kies hem opnieuw.'); tekenDeel($('ne-deel')).catch(function () {}); }).catch(function () { vb.innerHTML = leegVak('Foto niet gevonden. Kies hem opnieuw.'); });
  }

  // ---- deelafbeelding (1200 × 630) --------------------------------------------------------------------------------
  var logo = null;
  async function tekenDeel(c) {
    if (!c || !ed) return;
    var b = ed.b, g = c.getContext('2d'), W = 1200, H = 630, foto = null;
    try { await Promise.all([document.fonts.load('700 56px Onest'), document.fonts.load('italic 40px "Instrument Serif"')]); } catch (e) {}
    if (!logo) logo = await laadPlaatje('assets/ais-logo.png').catch(function () { return null; });
    if (b.beeld) { var u = await beeld(b.beeld).catch(function () { return ''; }); if (u) foto = await laadPlaatje(u).catch(function () { return null; }); }
    var vul = function (img, x, y, w, h) { var s = Math.max(w / img.naturalWidth, h / img.naturalHeight), sw = w / s, sh = h / s; g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h); };
    var regels = function (tekst, maxB, grootte) {
      g.font = '700 ' + grootte + 'px Onest, system-ui, sans-serif';
      var w = String(tekst || 'Titel van het bericht').split(/\s+/), uit = [], r = '';
      w.forEach(function (x) { var t = r ? r + ' ' + x : x; if (g.measureText(t).width > maxB && r) { uit.push(r); r = x; } else r = t; });
      if (r) uit.push(r); return uit;
    };
    var rustig = b.deelStijl === 'rustig' || !foto;
    g.clearRect(0, 0, W, H);
    if (rustig) {
      var gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#0d074f'); gr.addColorStop(1, '#1f1780'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(230,200,90,.10)'; g.beginPath(); g.arc(W - 60, -40, 360, 0, Math.PI * 2); g.fill();
      if (foto) { g.save(); g.beginPath(); g.roundRect ? g.roundRect(780, 150, 360, 360, 28) : g.rect(780, 150, 360, 360); g.clip(); vul(foto, 780, 150, 360, 360); g.restore(); }
    } else {
      vul(foto, 0, 0, W, H);
      var sch = g.createLinearGradient(0, 0, 0, H); sch.addColorStop(0, 'rgba(13,7,79,.25)'); sch.addColorStop(.45, 'rgba(13,7,79,.55)'); sch.addColorStop(1, 'rgba(13,7,79,.94)'); g.fillStyle = sch; g.fillRect(0, 0, W, H);
    }
    // logo in een wit vlak, rubriek in goud, titel in wit
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect ? g.roundRect(60, 54, 74, 74, 18) : g.rect(60, 54, 74, 74); g.fill();
    if (logo) g.drawImage(logo, 67, 61, 60, 60);
    g.fillStyle = '#fff'; g.font = '700 26px Onest, system-ui, sans-serif'; g.fillText('AIS-Groep', 152, 88); g.font = '400 20px Onest, system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,.75)'; g.fillText('Nieuws en tips voor de speciaalzaak', 152, 116);
    var maxB = rustig && foto ? 660 : 1060, grootte = 60, rr = regels(b.titel, maxB, grootte);
    while (rr.length > 3 && grootte > 40) { grootte -= 4; rr = regels(b.titel, maxB, grootte); }
    if (rr.length > 4) { rr = rr.slice(0, 4); rr[3] += '…'; }
    var lh = Math.round(grootte * 1.12), y0 = H - 70 - lh * (rr.length - 1);
    g.fillStyle = '#e6c85a'; g.font = '650 21px Onest, system-ui, sans-serif'; g.fillText(String(b.rubriek || 'Nieuws').toUpperCase().split('').join(String.fromCharCode(8202)), 60, y0 - grootte - 12);
    g.fillStyle = '#fff'; g.font = '700 ' + grootte + 'px Onest, system-ui, sans-serif';
    rr.forEach(function (r, i) { g.fillText(r, 60, y0 + i * lh); });
    g.fillStyle = '#e6c85a'; g.fillRect(60, H - 34, 120, 4);
  }

  // ---- voorbeeld zoals op de site -----------------------------------------------------------------------------------
  function tekenVoorbeeld() {
    var b = ed.b, r = md(b.tekst), kort = (b.kort || []).filter(function (k) { return k.trim(); });
    var auteur = (b.auteur || 'AIS-Groep').trim(), datum = new Date(b.publicatie && soort(b) !== 'concept' ? b.publicatie : ed.wanneer === 'later' ? isoUit(ed.datum, ed.tijd) : ed.wanneer === 'rij' ? (achteraan() || Date.now()) : Date.now());
    $('ne-voorbeeld').innerHTML = '<div class="vb"><div class="vb-hero"><div><span class="vb-eyebrow">' + esc(b.rubriek || 'Nieuws') + '</span><h1>' + esc(b.titel || 'Titel van het bericht') + '</h1>' +
      '<div class="vb-auteur"><span class="vb-av">' + esc(initialen(auteur)) + '</span><span><b>' + esc(auteur) + '</b>AIS-Groep · ' + datum.toLocaleDateString('nl-NL', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }) + ' · ' + Math.max(1, Math.round(woorden(b.tekst) / 200)) + ' min lezen</span></div></div>' +
      (b.beeld ? '<img id="vb-beeld" alt="' + esc(b.beeldAlt) + '">' : '') + '</div>' +
      '<div class="vb-lijf">' + (kort.length ? '<div class="vb-kort"><b>In het kort</b><ul>' + kort.map(function (k) { return '<li>' + inline(k) + '</li>'; }).join('') + '</ul></div>' : '') + (r.html || '<p style="color:var(--muted)">Nog geen tekst.</p>') + '</div></div>' +
      '<p class="ne-hint" style="margin-top:10px">Zo ongeveer ziet het bericht eruit op ais-groep.nl. Op de site staan ernaast nog de inhoudsopgave en de knop Plan een demo.</p>';
    if (b.beeld) beeld(b.beeld).then(function (u) { var i = $('vb-beeld'); if (!i) return; if (u) i.src = u; else i.remove(); }).catch(function () { if ($('vb-beeld')) $('vb-beeld').remove(); });
    $('ne-voorbeeld').querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); }); });
  }

  // ---- naar buiten ------------------------------------------------------------------------------------------------
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ed && !document.querySelector('.modal')) sluitEditor(); });
  window.addEventListener('beforeunload', function (e) { if (gewijzigd()) { e.preventDefault(); e.returnValue = ''; } });
  return {
    toon: function (c) { ctx = c; toon(); },
    uit: function () { opslag = null; berichten = []; geladen = false; beeldUrl = {}; if ($('neditor')) { $('neditor').remove(); document.body.style.overflow = ''; } ed = null; },
    _test: { md: md, htmlNaarMd: htmlNaarMd, maakSlug: maakSlug, isoUit: isoUit, seo: seo, woorden: woorden, soort: soort }
  };
})();
