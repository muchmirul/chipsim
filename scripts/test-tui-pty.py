#!/usr/bin/env python3
"""Exercise actual terminal I/O, model edits, export, resize, and mode cleanup."""
import fcntl,json,os,pty,re,select,struct,subprocess,tempfile,termios,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
NODE=os.environ.get('CHIPSIM_NODE','node')
ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
with tempfile.TemporaryDirectory(prefix='chipsim-pty-') as workspace:
 master,slave=pty.openpty()
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
 original=termios.tcgetattr(slave)
 proc=subprocess.Popen([NODE,'scripts/chipsim.mjs','--workspace',workspace,'--no-color'],cwd=ROOT,stdin=slave,stdout=slave,stderr=slave,close_fds=True)
 captured=''
 def frame():
  return ANSI.sub('',captured[captured.rfind('\x1b[H'):]).replace('\r','')
 def wait(text,timeout=8):
  global captured
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   if text in frame():return frame()
   if select.select([master],[],[],.05)[0]:
    try:chunk=os.read(master,65536)
    except OSError:break
    if not chunk:break
    captured=(captured+chunk.decode('utf8','replace'))[-500000:]
  raise AssertionError(f'Missing {text!r} in last terminal frame:\n{frame()}')
 def send(text):
  global captured
  captured=''
  os.write(master,text.encode())
 try:
  wait('CHIPSIM')
  assert not termios.tcgetattr(slave)[3]&termios.ICANON
  send('llF');wait('tick 2/59  state send  format decimal')
  send('p');wait('PARAMETERS')
  send('\r');wait('Payload')
  send('300\r');wait('Updated payload')
  send('6');wait('reg.osr')
  send('3');wait('Tick    State')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  trace=Path(workspace)/'trace.json'
  send(str(trace)+'\r');wait('Saved '+str(trace))
  exported=json.loads(trace.read_text())
  assert exported['parameters']['payload']==300
  assert next(s for s in exported['trace'] if s['phase']=='success')['registers']['decoded']==44
  fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
  proc.send_signal(__import__('signal').SIGWINCH)
  send('1');wait('q quit')

  # A new manual becomes an executable sourced model entirely inside the TUI.
  manual=Path(workspace)/'NewChipCounter.pdf'
  text='NewChip reference manual. A 16-bit counter increments when enabled. Reset clears the counter. Compare can toggle an output.'
  stream=f'BT /F1 12 Tf 40 700 Td ({text}) Tj ET'
  objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',f'<< /Length {len(stream.encode())} >>\nstream\n{stream}\nendstream']
  pdf='%PDF-1.4\n';offsets=[]
  for index,body in enumerate(objects):
   offsets.append(len(pdf.encode()));pdf+=f'{index+1} 0 obj\n{body}\nendobj\n'
  position=len(pdf.encode());pdf+='xref\n0 6\n0000000000 65535 f \n'+'\n'.join(f'{offset:010d} 00000 n ' for offset in offsets)+f'\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{position}\n%%EOF\n'
  manual.write_bytes(pdf.encode())
  send('d');wait('Import PDF')
  send(str(manual)+'\r');wait('PDF imported')
  send('c');wait('CREATE')
  send('\r');wait('CHOOSE SOURCE EXCERPT')
  send('\r');wait('Simulation name')
  for expected in ['Counter/transfer width','Direction','At compare','Default period','Evidence PDF page','Exact source excerpt','What the excerpt supports','Additional assumption']:
   send('\r');wait(expected)
  send('\r');wait('checks passed')
  send('t');wait('Go to normalized tick')
  send('8\r');wait('tick 8/')
  send('6');wait('signal.out')
  models=list((Path(workspace)/'models').glob('*.json'))
  assert len(models)==1
  created=json.loads(models[0].read_text())
  assert created['registers'][0]['width']==16
  assert created['evidence'][0]['page']==1
  assert len(created['checks'])==4
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/nexperia-74hc595.pdf')+'\r');wait('reviewed datasheet profile')
  send('t');wait('Go to normalized tick')
  send('18\r');wait('tick 18/')
  chip=json.loads((Path(workspace)/'models'/'hc595.json').read_text())
  assert chip['id']=='hc595' and len(chip['checks'])==8
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/nexperia-74hc00.pdf')+'\r');wait('74HC00; 74HCT00')
  send('6');wait('signal.pin_1a')
  table_models=[json.loads(path.read_text()) for path in (Path(workspace)/'models').glob('*.json')]
  table=next(model for model in table_models if 'sourceTable' in model)
  assert len(table['sourceTable']['instances'])==4 and len(table['signals'])==12
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/nexperia-74hc157.pdf')+'\r');wait('74HC157; 74HCT157')
  send('6');wait('signal.pin_e')
  send('i');wait('DRIVE INPUT')
  send('\r');wait('1-bit input at tick 0')
  send('0x1\r');wait('Input pin_e=1')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  mux_trace=Path(workspace)/'mux-trace.json'
  send(str(mux_trace)+'\r');wait('Saved '+str(mux_trace))
  mux=json.loads(mux_trace.read_text())
  assert mux['trace'][0]['signals']['pin_e']==1
  assert all(mux['trace'][0]['signals'][f'pin_{channel}y']==0 for channel in range(1,5))
  assert len(mux['trace'][0]['signals'])==14
  send('q');proc.wait(timeout=5)
  end=time.monotonic()+1
  while time.monotonic()<end and select.select([master],[],[],.05)[0]:
   try:captured+=os.read(master,65536).decode('utf8','replace')
   except OSError:break
  assert proc.returncode==0
  restored=termios.tcgetattr(slave)
  assert restored[3]&(termios.ICANON|termios.ECHO)==original[3]&(termios.ICANON|termios.ECHO)
  assert '\x1b[?25h' in captured and '\x1b[?1049l' in captured
  print('PTY verified: stepping, formats, register/log views, JSON export, resize, sourced scenarios, reviewed profiles, generic function tables, shared-pin compilation and direct input editing, and terminal cleanup.')
 finally:
  if proc.poll() is None:proc.terminate();proc.wait(timeout=5)
  os.close(master);os.close(slave)
