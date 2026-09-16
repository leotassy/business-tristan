"""Remet à zéro uniquement la démonstration partagée, avec sauvegarde préalable."""
import sqlite3
from pathlib import Path
from datetime import datetime

root = Path(__file__).resolve().parent
source = root / 'data' / 'demo-ami.sqlite3'
if not source.exists():
    raise SystemExit('Base de démonstration introuvable. Aucune modification.')
backup_dir = root / 'data' / 'sauvegardes'
backup_dir.mkdir(exist_ok=True)
backup = backup_dir / ('demo-avant-reset-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.sqlite3')
with sqlite3.connect(source) as reader, sqlite3.connect(backup) as destination:
    reader.backup(destination)
with sqlite3.connect(source) as db:
    db.execute('BEGIN IMMEDIATE')
    db.execute('DELETE FROM orders')
    db.execute('DELETE FROM events')
    db.execute("UPDATE lots SET price=0, status='upcoming', leader='external', version=version+1")
    assert db.execute('SELECT count(*) FROM orders').fetchone()[0] == 0
    assert db.execute('SELECT count(*) FROM events').fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM lots WHERE price<>0 OR status<>'upcoming'").fetchone()[0] == 0
    count = db.execute('SELECT count(*) FROM lots').fetchone()[0]
print(f'Démonstration réinitialisée : {count} lots conservés, aucun ordre, aucun prix, aucun événement.')
print(f'Sauvegarde : {backup}')
