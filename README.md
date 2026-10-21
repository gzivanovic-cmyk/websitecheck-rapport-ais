# Website-checks AIS-Groep (rapport.ais-groep.nl)

Persoonlijke klantpagina's van de website-check van AIS-Groep. Elke check staat in `r/<id>/`: `index.html` laadt `/bekijk.js`, `data.json` is het rapport, versleuteld met AES-256-GCM.

De sleutel staat alleen in de link die de klant krijgt (`https://rapport.ais-groep.nl/r/<id>/#<sleutel>`); hij komt nooit in deze repository en gaat niet naar de server. Een pagina verloopt na een jaar.
