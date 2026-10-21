# Social Pulse

Un piccolo progetto self-hosted per monitorare i contatori pubblici di link TikTok, Instagram e YouTube. Dashboard italiana, SQLite e worker integrato. Nessun abbonamento ad Apify o servizio di scraping. Non serve l'autorizzazione del creator per tentare la lettura dei dati già pubblici.

**È un MVP con raccolta best-effort: non garantisce di recuperare tutte e tre le metriche da ogni link.** Instagram può bloccare del tutto la lettura anonima; TikTok e YouTube possono richiedere login o bloccare l'IP del server. Un servizio self-hosted non elimina questi limiti. Non sono presenti aggiramenti di CAPTCHA, proxy, accesso ad account o sessioni salvate.

## Avvio rapido con Docker

Prerequisiti: Docker Engine con Docker Compose, accesso a Internet dal server.

```bash
cp .env.example .env
```

Apri `.env` e imposta `ADMIN_PASSWORD` con una password unica di almeno 12 caratteri. Poi:

```bash
docker compose up -d --build
```

Apri **http://localhost:8000**. Credenziali: `admin` e la password impostata.

Se Docker gira sul tuo server Ubuntu remoto, puoi accedere dal tuo computer con un tunnel:

```bash
ssh -L 8000:127.0.0.1:8000 ubuntu@IP_DEL_SERVER
```

Apri sempre `http://localhost:8000` dal computer. La porta Docker è esposta solo su loopback. Per un dominio pubblico aggiungi un reverse proxy HTTPS verso `127.0.0.1:8000`, imposta `PUBLIC_ORIGIN=https://tuo-dominio.it` e ricrea il container. L'autenticazione Basic richiede HTTPS quando attraversa reti non fidate. È un'app amministrativa per un piccolo team, non un servizio multiutente: tutti gli utenti con la password possono eliminare i post e lo storico.

## Cosa puoi fare

- Aggiungere un link, un'etichetta creator e un team.
- Controllare views, like e numero di commenti; non scarica i commenti o i video.
- Raccogliere ogni 60 minuti anche a dashboard chiusa, finché server e container restano accesi.
- Vedere variazioni dalla prima rilevazione, storico con timestamp e fonte.
- Filtrare per piattaforma e cercare creator, etichetta o team.
- Esportare lo storico di ciascun post in CSV, mettere in pausa, aggiornare o eliminare.
- Conservare lo storico nel volume Docker anche dopo un riavvio.

Non si possono ricostruire i contatori di prima dell'aggiunta del link. Non sono incluse classifiche di challenge, scadenze di gara, esportazione globale o rilevazione di engagement artificiale.

## Link e copertura reale

| Piattaforma | Formato | Metodo e limiti |
| --- | --- | --- |
| YouTube | `/watch?v=ID`, `youtu.be/ID`, `/shorts/ID`, `/live/ID` | API ufficiale se configurata; altrimenti metadati pubblici con yt-dlp. Alcuni contatori possono essere assenti. |
| TikTok | `https://www.tiktok.com/@utente/video/ID` | yt-dlp, senza login. I link brevi `vm.tiktok.com`, `vt.tiktok.com` e `/t/` vanno aperti nel browser e sostituiti con l'indirizzo completo. I post fotografici non sono supportati. |
| Instagram | `/reel/CODICE/`, `/reels/CODICE/`, `/p/CODICE/`, `/tv/CODICE/` | yt-dlp, senza login. Focus su video e Reel; foto e caroselli non sono garantiti e possono risultare non supportati. I contatori di più elementi di un carosello non vengono sommati. |

La possibilità di aprire un post manualmente non significa che il server possa estrarne i dati. Contatori nascosti, login obbligatorio, rimozioni e cambiamenti del sito possono produrre dati parziali o errori. Questo progetto non usa OCR: legge metadati strutturati, evitando di interpretare come valori esatti le abbreviazioni visuali come “1,2K”.

### Significato degli stati

- **Aggiornato**: tutte e tre le metriche presenti nell'ultima raccolta.
- **Dati parziali**: almeno una metrica disponibile; le altre sono `null` e mostrate come `—`.
- **Ultimo tentativo fallito**: nessuno snapshot nuovo; restano visibili i valori precedenti con la loro data.
- **In coda / Raccolta in corso**: controllo in attesa o in esecuzione.
- **In pausa**: niente nuove raccolte automatiche. Una già iniziata può completarsi.

Gli zeri reali restano `0`; i dati mancanti non vengono mai trasformati in zero. Se una metrica prima presente diventa assente, lo snapshot parziale nuovo la mostra come `—`, senza mescolare contatori di date diverse. I cali dei contatori vengono conservati. La variazione richiede che il valore sia disponibile sia nella prima sia nell'ultima rilevazione. Le metriche di piattaforme diverse non sono automaticamente confrontabili: non viene calcolato un punteggio unico.

## YouTube: API opzionale

1. Crea un progetto Google Cloud e abilita **YouTube Data API v3**.
2. Crea una API key, limitata a questa API e, se possibile, all'IP del server.
3. Imposta `YOUTUBE_API_KEY` in `.env`.
4. Esegui `docker compose up -d --force-recreate`.

Non richiede il login del creator per i video pubblici. Il collector usa `videos.list` con `statistics,snippet`. Quote e condizioni sono quelle del tuo progetto Google. Quando la chiave è presente il progetto usa solo questa strada per YouTube: gli errori di chiave/quota sono visibili e non attivano uno scraping silenzioso.

## Configurazione

| Variabile | Default | Significato |
| --- | --- | --- |
| `ADMIN_USER` | `admin` | Utente dashboard/API |
| `ADMIN_PASSWORD` | obbligatoria | Minimo 12 caratteri |
| `PUBLIC_ORIGIN` | `http://localhost:8000` | Origine esatta usata dal browser, per protezione richieste |
| `POLL_INTERVAL_MINUTES` | `60` | Intervallo dopo ogni raccolta, minimo 15 |
| `MAX_POSTS` | `100` | Limite post salvati, inclusi quelli in pausa |
| `YOUTUBE_API_KEY` | vuota | Attiva l'API ufficiale YouTube |
| `DATABASE_PATH` | `data/pulse.sqlite3` | Percorso SQLite, normalmente da non modificare |

Worker singolo: massimo un post alla volta, timeout di 90 secondi e 10 secondi di pausa tra post. Se molti controlli sono in coda gli orari slittano. L'aggiornamento manuale ha un cooldown di 5 minuti. Dopo errori consecutivi il ritardo cresce fino a 24 ore; una raccolta riuscita ripristina l'intervallo normale. Il progetto non promette un campionamento esatto al minuto o identico tra post.

## Sviluppo senza Docker

Python 3.12 consigliato.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export ADMIN_PASSWORD='scegli-una-password-unica'
python app.py
```

L'avvio Python diretto legge le variabili d'ambiente, **non carica `.env` automaticamente**. Per usare la chiave YouTube fai anche `export YOUTUBE_API_KEY='...'`. Non avviare più istanze sullo stesso database: il worker è integrato nel processo.

```bash
python -m unittest discover -s tests -v
```

## Aggiornamenti e backup

I siti cambiano: yt-dlp è una dipendenza aggiornabile e non è bloccata a una singola release. Per ricevere extractor aggiornati:

```bash
docker compose build --no-cache
docker compose up -d
```

Senza Docker: `pip install -U yt-dlp`. Dopo un aggiornamento prova alcuni link reali prima di usarli per una challenge. Per vedere la versione installata: `docker compose exec social-pulse python -m yt_dlp --version`.

Backup consistente a server acceso tramite l'API backup di SQLite:

```bash
docker compose exec social-pulse python -c "import sqlite3; s=sqlite3.connect('/app/data/pulse.sqlite3'); d=sqlite3.connect('/app/data/backup.sqlite3'); s.backup(d); d.close(); s.close()"
docker compose cp social-pulse:/app/data/backup.sqlite3 ./backup.sqlite3
```

Non eseguire `docker compose down -v` se vuoi conservare i dati: rimuove il volume. Lo storico cresce senza scadenza automatica; eliminare un post elimina anche i suoi snapshot. Effettua backup periodici.

## Struttura

- `app.py`: HTTP, autenticazione, API e worker.
- `collectors.py`: validazione link e raccolta YouTube/yt-dlp.
- `storage.py`: SQLite, snapshot e pianificazione.
- `static/`: dashboard senza dipendenze JavaScript esterne.
- `tests/`: unit test e test HTTP locali, senza chiamate alle piattaforme.

## Verifica di questa consegna

I test coprono normalizzazione e rifiuto URL non ammessi, dati mancanti, timeout, conservazione dell'ultimo dato dopo errori, backoff, esclusione raccolte sovrapposte, pausa, cancellazione durante raccolta, autenticazione, controllo Origin, duplicati e CSV. Non equivalgono a una verifica live dei collector sui tre social. Nessun link reale è stato fornito dall'utente per una prova di accettazione. Nessun dato dimostrativo è precaricato.

## Fonti tecniche

- yt-dlp e campi metadati: https://github.com/yt-dlp/yt-dlp
- YouTube Videos: https://developers.google.com/youtube/v3/docs/videos
- YouTube API: https://developers.google.com/youtube/v3/getting-started
- TikTok API ufficiale (richiede token utente, non usata qui): https://developers.tiktok.com/doc/tiktok-api-v2-video-query/
- Instagram API ufficiale (autorizzazioni/account supportati, non usata qui): https://www.postman.com/meta/instagram/collection/6yqw8pt/instagram-api
