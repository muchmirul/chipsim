#!/usr/bin/env python3
"""Exercise the installed prime-agent Python MCP client, without model turns.

Only the host configuration RPC is supplied by the harness, pointing at isolated
projects. Transport, SDK negotiation, discovery, errors, reconnect and calls use
prime-agent's installed rlm.mcp implementation unchanged. No user settings writes.
"""
import argparse
import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


async def acceptance(args, runtime):
    sys.path.insert(0, str(runtime))
    from rlm import mcp
    from rlm.mcp_base import McpToolError

    repository = Path(__file__).resolve().parents[1]
    node = str(Path(args.node or shutil.which('node')).resolve())
    prime = Path(args.prime or shutil.which('prime-agent')).resolve()
    version = subprocess.run([str(prime), '--version'], check=True,
                             capture_output=True, text=True).stdout.strip()
    parent = Path(tempfile.mkdtemp(prefix='chipsim-prime-mcp-'))
    roots = {name: parent / name for name in ('chipsim-test', 'chipsim-other')}
    for root in roots.values():
        root.mkdir()
    configs = {name: {'type': 'stdio', 'command': node,
                     'args': [str(repository / 'scripts/chipsim.mjs'),
                              'mcp', '--project', str(root)]}
               for name, root in roots.items()}

    registered_bytes = None
    if args.registered_settings:
        registered_bytes = args.registered_settings.read_bytes()
        entry = json.loads(registered_bytes).get('mcpServers', {}).get('chipsim')
        assert entry and entry.get('type') == 'stdio', 'Expected registered chipsim stdio entry'
        configs['chipsim'] = entry

    async def host_request(method, payload):
        if method != 'mcp.config':
            raise AssertionError('Unexpected host RPC: ' + method)
        return configs[payload['server']]

    # This is the host-owned config resolution seam, not a substitute MCP client.
    mcp.host_request = host_request
    connection = 'chipsim-test'

    async def call(tool, arguments=None, server=connection):
        result = await mcp.call_tool(server, 'chipsim_' + tool, arguments or {})
        assert isinstance(result, dict), 'Prime must preserve structured results'
        assert result['format'] == 'chipsim-workbench-result'
        assert result['ok'] is True, result
        return result['result']

    try:
        tools = await mcp.list_tools(connection)
        names = {tool['name'] for tool in tools}
        expected = json.loads(subprocess.run(
            [node, str(repository / 'scripts/chipsim.mjs'), 'workbench', 'tools'],
            check=True, capture_output=True, text=True).stdout)['result']['tools']
        expected_schemas = {'chipsim_' + tool['name']: tool['inputSchema'] for tool in expected}
        assert {tool['name']: tool['inputSchema'] for tool in tools} == expected_schemas
        assert {'chipsim_manufacturing_profiles', 'chipsim_workflow_status',
                'chipsim_artifact_read', 'chipsim_release_package'} <= names
        registered = None
        if args.registered_settings:
            registered_tools = await mcp.list_tools('chipsim')
            assert {tool['name']: tool['inputSchema'] for tool in registered_tools} == expected_schemas
            registered_project = await call('project', server='chipsim')
            registered = {'toolCount': len(registered_tools), 'project': registered_project['root'],
                          'scope': 'Read-only probe using the existing registered stdio descriptor'}
        for guide in ('connections', 'workbench'):
            reply = await call('resource_read', {'uri': 'chipsim://guide/' + guide})
            assert reply['mimeType'] == 'text/markdown' and reply['text']
            if guide == 'workbench':
                project = await call('project')
                assert project['toolInventorySha256'] in reply['text']
                assert f"**{len(tools)} MCP tools**" in reply['text']
        # The exception on a tools-only host still carries the service's code.
        ctx = await call('benchmark_prepare', {'benchmark': 'counter'})
        rtl = (await call('resource_read', {'uri': ctx['candidateResource']}))['text']
        try:
            await call('benchmark_start', {'context': ctx['context'], 'content': rtl,
                                           'candidateHash': '0' * 64, 'requestId': 'bad-digest'})
            raise AssertionError('A mismatched candidate digest must fail before dispatch')
        except McpToolError as error:
            problem = json.loads(str(error))['error']
            assert problem['code'] == 'CANDIDATE_HASH_MISMATCH' and not problem['details']['retryable']
        profiles = await call('manufacturing_profiles')
        assert profiles['profiles'][0]['id'] == 'tinytapeout-ihp-v1'
        assert (await call('project'))['root'] == str(roots[connection])
        assert (await call('workflow_status'))['prepared'] is False
        files = {
            'input.txt': '7',
            'worker.mjs': "import {readFile,writeFile} from 'node:fs/promises';"
                          "await new Promise(r=>setTimeout(r,500));"
                          "const value=Number(await readFile('input.txt','utf8'));"
                          "await writeFile('result.json',JSON.stringify({value}));",
            'chipsim.design.json': json.dumps({
                'format': 'chipsim-design', 'version': 1, 'id': 'prime-mcp-test',
                'engineering': {'requirements': [{'id': 'two-inputs'}]},
                'tasks': {'run': {
                    'adapter': 'command', 'inputs': ['input.txt', 'worker.mjs'],
                    'options': {'command': node, 'args': ['worker.mjs']},
                    'outputs': [{'path': 'result.json', 'kind': 'report'}],
                    'checks': [{'name': 'value', 'path': 'result.json',
                                'field': 'value', 'operator': 'eq', 'value': 7,
                                'scope': 'Original MCP lifecycle fixture'}]}},
                'targets': {'simulation': {'tasks': ['run'],
                                           'requiredChecks': ['run:value', 'run:outputs']}}}),
            'chipsim.lock.json': json.dumps({'format': 'chipsim-lock', 'version': 1,
                                             'dependencies': []}),
        }
        for path, text in files.items():
            await call('file_write', {'path': path, 'text': text, 'expectedHash': None})
        original = await call('file_read', {'path': 'input.txt'})
        assert original['sha256'] == digest(b'7')
        try:
            await call('file_write', {'path': 'input.txt', 'text': 'bad',
                                      'expectedHash': '0' * 64})
            raise AssertionError('CAS conflict must raise McpToolError')
        except McpToolError as error:
            assert 'EDIT_CONFLICT' in str(error)
        assert (await call('file_read', {'path': 'input.txt'}))['text'] == '7'
        try:
            await call('file_read', {'path': 'input.txt'}, server='chipsim-other')
            raise AssertionError('Project roots must be isolated')
        except McpToolError as error:
            assert 'ENOENT' in str(error)
        assert (await call('project', server='chipsim-other'))['root'] == str(roots['chipsim-other'])
        await call('validate', {'target': 'simulation'})
        job = await call('job_start', {'target': 'simulation', 'requestId': 'prime-reconnect', 'reuse': False})
        await mcp.reload(connection)
        replay = await call('job_start', {'target': 'simulation', 'requestId': 'prime-reconnect', 'reuse': False})
        assert replay['id'] == job['id']
        while True:
            state = await call('job_status', {'job': job['id'], 'waitMs': 10000})
            if state['state'] in ('completed', 'failed', 'cancelled', 'interrupted'):
                break
        assert state['state'] == 'completed' and state['ready'], state
        checks = await call('checks', {'target': 'simulation', 'run': state['run']})
        assert checks['ready'] and checks['requirementCoverage']['status'] == 'unverified', checks
        assert checks['requirementCoverage']['unverified'] == ['two-inputs'], checks
        page = await call('artifacts', {'run': state['run'], 'limit': 200})
        artifact = next(a for a in page['items'] if a['path'] == 'result.json')
        chunk = await call('artifact_read', {'artifact': artifact['id'], 'offset': 0, 'limit': 65536})
        data = base64.b64decode(chunk['data'])
        assert digest(data) == chunk['sha256'] == chunk['chunkSha256']
        assert json.loads(data) == {'value': 7}
        summary = {
            'format': 'chipsim-prime-mcp-acceptance', 'version': 1,
            'primeVersion': version, 'primeBinarySha256': digest(prime.read_bytes()),
            'runtimeClientSha256': digest((runtime / 'rlm/mcp.py').read_bytes()),
            'registeredConnection': registered,
            'toolCount': len(tools), 'toolInventorySha256': (await call('project'))['toolInventorySha256'],
            'project': str(roots[connection]), 'job': state['id'], 'run': state['run'],
            'scenarios': ['tools-only-guide-access', 'all-workbench-schemas',
                          'manufacturing-discovery', 'structured-results',
                          'CAS-error-propagation', 'isolated-project-roots',
                          'managed-job', 'client-reload-durable-request-replay',
                          'target-vs-requirement-coverage', 'guide-inventory-match',
                          'candidate-digest-error', 'verified-binary-retrieval'],
            'scope': 'Installed prime-agent rlm.mcp client and MCP transport; config RPC supplied by isolated harness. No model turn, provider call or user-settings mutation. Lifecycle fixture is not native EDA validation.',
            'validatedAt': datetime.now(timezone.utc).isoformat(),
            'testSha256': digest(Path(__file__).read_bytes()),
        }
        if args.registered_settings:
            assert args.registered_settings.read_bytes() == registered_bytes, 'User settings must remain unchanged'
        (parent / 'acceptance.json').write_text(json.dumps(summary, indent=2) + '\n')
        print(json.dumps(summary, indent=2))
    finally:
        await mcp.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prime', help='Installed prime-agent executable')
    parser.add_argument('--runtime-src', type=Path, help='Installed prime-agent-runtime/src directory')
    parser.add_argument('--registered-settings', type=Path, help='Optional read-only probe of the existing chipsim entry')
    parser.add_argument('--node', help='Node 22.13+ executable')
    args = parser.parse_args()
    prime = Path(args.prime or shutil.which('prime-agent') or 'prime-agent').resolve()
    runtime = args.runtime_src or prime.parent / 'prime-agent-runtime/src'
    if not (runtime / 'rlm/mcp.py').is_file():
        parser.error('Installed prime-agent Python runtime not found; use --runtime-src')
    asyncio.run(acceptance(args, runtime.resolve()))
