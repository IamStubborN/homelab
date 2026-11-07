"""Exercise the real resume module only in an isolated disposable canary."""
import argparse
import json
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--container', required=True)
args = parser.parse_args()
container = json.loads(subprocess.check_output(['docker', 'inspect', args.container]))[0]
assert container['HostConfig']['NetworkMode'] == 'none', 'canary must have no network'
assert container['Config']['Labels'].get('traefik.enable') == 'false'
assert not container['HostConfig'].get('PortBindings'), 'canary must not publish ports'
for mount in container['Mounts']:
    if mount['Destination'] in ['/lampac/database', '/lampac/cache', '/lampac/logs']:
        assert mount['Type'] == 'bind' and mount['Source'].startswith('/tmp/'), 'never test against production state'

def request(query='', data=None, chunked=False):
    command = ['docker', 'exec', args.container, 'curl', '--silent', '--show-error', '--max-time', '10',
               '--write-out', '\n%{http_code}', 'http://127.0.0.1:9118/homelab-sync/resume' + query]
    if data is not None:
        command += ['-H', 'Content-Type: application/json', '--data-binary', json.dumps(data)]
    if chunked:
        command += ['-H', 'Transfer-Encoding: chunked']
    body, status = subprocess.check_output(command, text=True).rsplit('\n', 1)
    return int(status), json.loads(body) if body.startswith(('{', '[')) else body

assert request()[0] == 401
now = int(time.time() * 1000)
item = dict(card='tv_42', title='Synthetic series', torrent='a' * 40, index=1,
            timeline='123', season=1, episode=2, position=80, duration=120,
            observed=now, tracks={'audio': {'title': 'Preferred', 'language': 'ru'}})
area = '?uid=synthetic-review&profile_id=a'
assert request(area, item)[0] == 200
assert request(area)[1]['items'][0]['position'] == 80
assert request('?uid=synthetic-review&profile_id=b')[1]['items'] == []
assert request('?uid=other-synthetic&profile_id=a')[1]['items'] == []
status, body = request(area, dict(item, position=10, observed=now - 10000))
assert status == 200 and body.get('stale') is True, 'an older observation is reported as stale'
assert request(area)[1]['items'][0]['position'] == 80
for invalid in [dict(item, index=0), dict(item, duration=90000)]:
    assert request(area, invalid)[0] == 400
status, body = request(area, dict(item, card='tv_7', observed=now + 3600000))
assert status == 200 and abs(body['observed'] - int(time.time() * 1000)) < 60000, 'a skewed clock is clamped, not rejected'
for chunked in [False, True]:
    assert request(area, dict(item, title='x' * 20000), chunked)[0] == 413
online = dict(item, kind='online', torrent=None, index=0, observed=now + 1,
              online=dict(provider='kinobase', voice='Preferred', season_index=0))
assert request(area, online)[0] == 200
def by(card):
    return [i for i in request(area)[1]['items'] if i['card'] == card][0]
assert by('tv_42')['kind'] == 'online'
assert request(area, item)[0] == 200
assert by('tv_42')['kind'] == 'online', 'stale torrent must not replace newer online source'
movie = dict(online, card='movie_42', season=0, episode=0, observed=now + 1,
             online=dict(provider='kinobase', voice='Preferred', season_index=0, text='Licensed Dub',
                         match=dict(index=0, count=3, url='/lite/one/video?i=0', text='Licensed Dub', translate='', voice_name='2160p')))
assert request(area, movie)[0] == 200
saved = by('movie_42')['online']['match']
assert saved.get('index', 0) == 0 and saved['count'] == 3 and saved['voice_name'] == '2160p' and 'url' not in saved, 'match persists without resolver url'
for invalid in [dict(online, torrent='a' * 40), dict(online, index=1), dict(online, online=None),
                dict(online, kind='other'), dict(online, online=dict(provider='https://private', voice='', season_index=0)),
                dict(online, online=dict(provider='kinobase', voice='x' * 201, season_index=0)),
                dict(online, online=dict(provider='kinobase', voice='', season_index=-1)),
                dict(online, online=dict(provider='kinobase', voice='', season_index=0, text='x' * 201)),
                dict(online, online=dict(provider='kinobase', voice='', season_index=0, match=dict(index=0, count=1))),
                dict(movie, online=dict(provider='kinobase', voice='', season_index=0, match=dict(index=2, count=2))),
                dict(movie, online=dict(provider='kinobase', voice='', season_index=0, match=dict(index=0, count=1, translate='x' * 201)))]:
    assert request(area, invalid)[0] == 400
status, body = request(area, dict(card='tv_42', deleted=True))
assert status == 200 and not body.get('stale')
assert [i for i in request(area)[1]['items'] if i['card'] == 'tv_42'][0].get('deleted') is True
assert request(area, dict(online, observed=now + 2))[1].get('stale') is True, 'a dismissal wins over older observations'
for i in range(43, 94):
    assert request(area, dict(item, card=f'tv_{i}', observed=int(time.time() * 1000)))[0] == 200
assert len(request(area)[1]['items']) == 50
print('PASS: auth, user/profile isolation, stale-write ordering, clock clamping, dismissal tombstones, source replacement, online identity validation, bounded bodies and fifty-item storage')
