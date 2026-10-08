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
 def wait(text,timeout=8,absent=None):
  global captured
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   if text in frame() and (absent is None or absent not in frame()):return frame()
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
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/nexperia-74hc377.pdf')+'\r');wait('74HC377; 74HCT377')
  send('p');wait('PARAMETERS')
  send('\r');wait('Initial retained output bits')
  send('0xB3\r');wait('Updated initialOutputs')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  state_trace=Path(workspace)/'sequential-trace.json'
  send(str(state_trace)+'\r');wait('Saved '+str(state_trace))
  retained=json.loads(state_trace.read_text())
  word=lambda snapshot:sum(snapshot['signals'][f'pin_q{bit}']<<bit for bit in range(8))
  assert word(retained['trace'][0])==0xb3 and len(retained['trace'][0]['signals'])==18
  assert word(retained['trace'][2])==0xaa
  assert retained['trace'][2]['registers']['rise_pin_cp']==1
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/nexperia-74hc273.pdf')+'\r');wait('74HC273; 74HCT273')
  send('6');wait('signal.pin_mr')
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/ti-sn74lvc1g125.pdf')+'\r');wait('SN74LVC1G125')
  send('t');wait('Go to normalized tick')
  send('4\r');wait('tick 4/')
  send('6');wait('signal.pin_y')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  buffer_trace=Path(workspace)/'buffer-trace.json'
  send(str(buffer_trace)+'\r');wait('Saved '+str(buffer_trace))
  buffer=json.loads(buffer_trace.read_text())
  assert buffer['trace'][4]['signals']['pin_y']=='Z'
  assert buffer['trace'][2]['signals']['pin_y']==1
  send('i');wait('DRIVE INPUT')
  send('\r');wait('1-bit input at tick 4')
  send('0b0\r');wait('Input pin_oe=0')
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/ti-pca9555.pdf')+'\r');wait('PCA9555')
  send('u');wait('REGISTER ACCESS')
  send('jj\r');wait('Output port 0')
  send('j\r');wait('Write Output port 0')
  send('0o245\r');wait('write address 2 at tick 1')
  send('u');wait('REGISTER ACCESS')
  send('jj\r');wait('Output port 0')
  send('\r');wait('read address 2 at tick 2')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  register_trace=Path(workspace)/'register-trace.json'
  send(str(register_trace)+'\r');wait('Saved '+str(register_trace))
  registers=json.loads(register_trace.read_text())
  assert registers['trace'][1]['registers']['output0']==165
  assert registers['trace'][2]['signals']['read_data']==165
  assert registers['trace'][4]['registers']['configuration0']==240
  assert registers['trace'][8]['signals']['int_driver']==0
  assert registers['trace'][12]['signals']['int_driver']=='Z'
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/ti-tca9534.pdf')+'\r');wait('TCA9534')
  send('u');wait('REGISTER ACCESS')
  send('j\r');wait('Output port')
  send('j\r');wait('Write Output port')
  send('0o245\r');wait('write address 1 at tick 1')
  send('u');wait('REGISTER ACCESS')
  send('jjj\r');wait('Configuration')
  send('j\r');wait('Write Configuration')
  send('0b0\r');wait('write address 3 at tick 2')
  send('u');wait('REGISTER ACCESS')
  send('j\r');wait('Output port')
  send('\r');wait('read address 1 at tick 3')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  gpio_trace=Path(workspace)/'tca9534-trace.json'
  send(str(gpio_trace)+'\r');wait('Saved '+str(gpio_trace))
  gpio=json.loads(gpio_trace.read_text())
  assert gpio['trace'][1]['registers']['output0']==165
  assert gpio['trace'][2]['registers']['configuration0']==0
  assert gpio['trace'][2]['signals']['p01_driver']==0
  assert gpio['trace'][3]['signals']['read_data']==165
  assert gpio['trace'][8]['signals']['int_driver']==0
  assert gpio['trace'][10]['signals']['int_driver']==0
  assert gpio['trace'][12]['signals']['int_driver']=='Z'
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/renesas-hd74hc77.pdf')+'\r');wait('HD74HC77 Datasheet')
  send('t');wait('Go to normalized tick')
  send('4\r');wait('tick 4/')
  send('6');wait('signal.pin_data')
  send('i');wait('DRIVE INPUT')
  send('\r');wait('1-bit input at tick 4')
  send('0x1\r');wait('Input pin_data=1')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  latch_trace=Path(workspace)/'latch-trace.json'
  send(str(latch_trace)+'\r');wait('Saved '+str(latch_trace))
  latch=json.loads(latch_trace.read_text())
  assert latch['trace'][4]['signals']['pin_q']==1
  assert latch['trace'][10]['signals']['pin_data']==0 and latch['trace'][10]['signals']['pin_q']==1
  assert latch['model']['definition']['sourceTable']['compiler']=='retained-function-table-v1'
  # Build and revise a pin experiment without typing input JSON.
  send('7');wait('Tick / input pin')
  send('a');wait('STIMULUS ACTIONS')
  send('j\r');wait('Explicit stimulus cleared')
  send('i');wait('SCHEDULE INPUT')
  send('j\r');wait('Event tick')
  send('0x0\r');wait('scheduled value')
  send('0b1\r');wait('Scheduled pin_enableg=1 at tick 0')
  send('i');wait('SCHEDULE INPUT')
  send('k\r');wait('Event tick')
  send('0o3\r');wait('scheduled value')
  send('1\r');wait('Scheduled pin_data=1 at tick 3')
  send('\r');wait('Move to another tick')
  send('jj\r');wait('Move event to tick')
  send('0x4\r');wait('Updated pin_data at tick 4')
  send('\x1b[3~');wait('Removed pin_data at tick 4')
  send('U');wait('Stimulus undone')
  send('R');wait('Stimulus redone')
  send('U');wait('Stimulus undone')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  experiment_trace=Path(workspace)/'experiment-trace.json'
  send(str(experiment_trace)+'\r');wait('Saved '+str(experiment_trace))
  experiment=json.loads(experiment_trace.read_text())
  assert experiment['inputs']==[{'tick':0,'signal':'pin_enableg','value':1},{'tick':4,'signal':'pin_data','value':1}]
  assert experiment['trace'][3]['signals']['pin_q']==0
  assert experiment['trace'][4]['signals']['pin_q']==1
  assert experiment['trace'][10]['signals']['pin_q']==1
  # A multi-level centered decoder table imports without authoring JSON.
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/renesas-hd74hc138.pdf')+'\r');wait('HD74HC138')
  send('6');wait('signal.pin_y0')
  send('i');wait('DRIVE INPUT')
  send('\r');wait('1-bit input at tick 0')
  send('1\r');wait('Input pin_g1=1')
  send('i');wait('DRIVE INPUT')
  send('jjjjj\r');wait('1-bit input at tick 0')
  send('0b1\r');wait('Input pin_a=1')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  decoder_trace=Path(workspace)/'decoder-trace.json'
  send(str(decoder_trace)+'\r');wait('Saved '+str(decoder_trace))
  decoder=json.loads(decoder_trace.read_text())
  assert decoder['model']['definition']['sourceTable']['page']==4
  assert decoder['trace'][0]['signals']['pin_y0']==1
  assert decoder['trace'][0]['signals']['pin_y1']==0
  assert len(decoder['trace'][0]['signals'])==14
  # A clock held high must not capture a new data value.
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/ti-sn74ahc273-q1.pdf')+'\r');wait('SN74AHC273-Q1')
  send('6');wait('signal.pin_clr')
  send('t');wait('Go to normalized tick')
  send('15\r');wait('tick 15/')
  send('i');wait('DRIVE INPUT')
  send('jj\r');wait('1-bit input at tick 15')
  send('0\r');wait('Input pin_d=0')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  clock_trace=Path(workspace)/'clock-trace.json'
  send(str(clock_trace)+'\r');wait('Saved '+str(clock_trace))
  clock=json.loads(clock_trace.read_text())
  assert clock['trace'][14]['signals']['pin_q']==1
  assert clock['trace'][15]['signals']['pin_d']==0 and clock['trace'][15]['signals']['pin_q']==1
  assert clock['trace'][15]['registers']['pair_pin_clk']==3
  assert clock['model']['definition']['sourceTable']['symbolRows'][1]['inputs'][1]=='L, H, ↓'
  assert clock['model']['definition']['sourceTable']['retention']['symbol']=='Q0'
  # Author custom rows from a real source, including correction of an incomplete file.
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/nexperia-74hc00.pdf')+'\r');wait('74HC00; 74HCT00')
  send('c');wait('CREATE')
  send('jjj\r');wait('Behavior table · simulation name')
  send('Reviewed NAND\r');wait('Input pin names')
  send('\r');wait('Output pin names')
  send('\r');wait('State names')
  send('\r');wait('Rows · state BITS')
  rules=Path(workspace)/'nand.rules.txt'
  rules.write_text('logic 00 -> logic / 1\n')
  send('@'+str(rules)+'\r');wait('No row covers')
  rules.write_text((ROOT/'examples/nand.rules.txt').read_text())
  send('\x15@'+str(rules)+'\r');wait('Evidence PDF page')
  send('0x3\r');wait('Exact source excerpt')
  send('Quad 2-input NAND gate\r');wait('What this excerpt supports')
  send('Entered rows match the single NAND function on this page.\r');wait('Additional assumption')
  send('One gate; normalized steps; package replication omitted.\r');wait('4 checks passed')
  authored=json.loads((Path(workspace)/'models'/'reviewed-nand.json').read_text())
  assert 'sourceTable' not in authored
  assert 'not inferred from the PDF' in authored['scope']
  assert authored['evidence'][0]['page']==3
  send('t');wait('Go to normalized tick')
  send('3\r');wait('tick 3/')
  send('6');wait('reg.behavior_state')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  authored_trace=Path(workspace)/'authored-trace.json'
  send(str(authored_trace)+'\r');wait('Saved '+str(authored_trace))
  authored=json.loads(authored_trace.read_text())
  assert [s['signals']['pin_y'] for s in authored['trace'][1:5]]==[1,1,0,1]
  assert authored['trace'][3]['state']=='state_logic'
  # Revise, review without committing, then restore the whole prior experiment.
  original_model=json.loads((Path(workspace)/'models'/'reviewed-nand.json').read_text())
  send('E');wait('EDIT BEHAVIOR TABLE')
  send('\r');wait('Rows · state BITS')
  send('logic 0X -> logic / 1; logic X0 -> logic / 1; logic 11 -> logic / 1\r');wait('› Rows')
  send('jjjjjj\r');wait('─ What this excerpt supports')
  send('NAND source retained; forced-high output is a developer test override.\r');wait('› What this excerpt supports')
  send('j\r');wait('─ Additional assumption')
  send('Forced-high test scenario; not vendor NAND behavior.\r');wait('› Additional assumption')
  send('jj\r');wait('DRAFT REVIEW')
  wait('Y: 0 → 1')
  send('jjj\r');wait('TRACE DIFFERENCES')
  wait('first 3')
  send('\r');wait('TICK 3 DIFFERENCES')
  wait('signal.pin_y: 0 → 1')
  assert json.loads((Path(workspace)/'models'/'reviewed-nand.json').read_text())==original_model
  # Inspect the affected menu at both supported terminal sizes.
  fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
  proc.send_signal(__import__('signal').SIGWINCH)
  wait('signal.pin_y: 0 → 1')
  send('\r');wait('TRACE DIFFERENCES')
  send('k\r');wait('DRAFT REVIEW')
  send('\r');wait('› Review draft')
  send('j\r');wait('Saved revision')
  wait('tick 3/')
  revised=json.loads((Path(workspace)/'models'/'reviewed-nand.json').read_text())
  assert revised['authoring']['configuration']['rules'].endswith('logic 11 -> logic / 1')
  history=Path(workspace)/'revisions'/'reviewed-nand'
  assert len(list(history.glob('*.session.json')))==1
  send('E');wait('EDIT BEHAVIOR TABLE')
  send('jjjjjjjjjjjjj\r');wait('REVISION BACKUPS')
  send('\r');wait('Revision restored')
  wait('tick 3/')
  assert json.loads((Path(workspace)/'models'/'reviewed-nand.json').read_text())==original_model
  assert len(list(history.glob('*.session.json')))==2
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  restored_trace=Path(workspace)/'restored-trace.json'
  send(str(restored_trace)+'\r');wait('Saved '+str(restored_trace))
  restored_experiment=json.loads(restored_trace.read_text())
  assert restored_experiment['trace'][3]['signals']['pin_y']==0
  assert restored_experiment['model']['definition']['authoring']==original_model['authoring']
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/rp2040-datasheet.pdf')+'\r');wait('Loaded RP2040 PIO')
  send('c');wait('CREATE')
  send('jjjj\r');wait('Register bank · simulation name')
  send('Scratch storage experiment\r');wait('Register word width')
  send('32\r');wait('Register rows')
  send('@'+str(ROOT/'examples/rp2040-watchdog-scratch.registers.txt')+'\r');wait('Synthetic hardware set')
  send('before\r');wait('Evidence PDF page')
  send('549\r');wait('Exact source excerpt')
  send('Information persists through soft reset of the chip.\r');wait('What the excerpt supports')
  send('Table 549 supports the entered 32-bit scratch storage words.\r');wait('Additional assumption')
  send('No physical bus, watchdog counter, aliases or reset domains modeled.\r');wait('Added Scratch storage experiment')
  send('u');wait('REGISTER ACCESS')
  send('\r');wait('SCRATCH0')
  send('j\r');wait('Write SCRATCH0')
  send('0xDEADBEEF\r');wait('write address 12 at tick 1')
  send('u');wait('REGISTER ACCESS')
  send('\r');wait('SCRATCH0')
  send('\r');wait('read address 12 at tick 2')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  scratch_trace=Path(workspace)/'scratch-trace.json'
  send(str(scratch_trace)+'\r');wait('Saved '+str(scratch_trace))
  scratch=json.loads(scratch_trace.read_text())
  assert scratch['trace'][1]['registers']['value_SCRATCH0']==0xDEADBEEF
  assert scratch['trace'][2]['signals']['read_data']==0xDEADBEEF
  assert len(scratch['model']['definition']['registerMap'])==8
  assert scratch['model']['definition']['evidence'][0]['page']==549
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/espressif-esp32-c6-trm.pdf')+'\r');wait('ESP32-C6 · PCNT channel 0',timeout=30)
  send('p');wait('PARAMETERS')
  send('\r');wait('Rising edge')
  send('0x2\r');wait('Updated positive_mode')
  send('t');wait('Go to normalized tick')
  send('13\r');wait('tick 13/34')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  c6_trace=Path(workspace)/'esp32c6-pcnt-trace.json'
  send(str(c6_trace)+'\r');wait('Saved '+str(c6_trace))
  c6=json.loads(c6_trace.read_text())
  assert c6['model']['id']=='esp32c6-pcnt'
  assert c6['parameters']['positive_mode']==2
  assert c6['trace'][1]['registers']['pulse_count']==65535
  assert c6['trace'][9]['signals']['low_limit_hit']==1
  assert c6['trace'][13]['registers']['pulse_count']==2
  send('4');wait('2 simulation(s) available')
  send('o');wait('SIMULATIONS')
  assert 'SCOPE / ACTION' in frame()
  send('\r');wait('Opened ESP32-C6')
  assert 'tick 13/34' in frame()
  send('o');wait('SIMULATIONS')
  send('jj\r');wait('CREATE SIMULATION',timeout=30)
  assert 'Existing models are preserved' in frame() or 'h/l scroll' in frame()
  send('\x1b');wait('tick 13/34',absent='CREATE SIMULATION')
  assert len(list((Path(workspace)/'models').glob('esp32c6-pcnt*.json')))==1
  send('o');wait('SIMULATIONS')
  send('j\r');wait('Opened ESP32-C6 · GPIO')
  send('u');wait('REGISTER ACCESS')
  send('j\r');wait('GPIO_OUT_W1TS_REG · tick 1')
  assert 'Read' not in frame()
  send('\r');wait('Write GPIO_OUT_W1TS_REG')
  send('0x40000001\r');wait('tick 1/24')
  send('6');wait('0x04 GPIO_OUT_REG')
  send('x');wait('EXPORT FULL TRACE')
  send('j\r');wait('Output path')
  gpio_trace=Path(workspace)/'esp32c6-gpio-trace.json'
  send(str(gpio_trace)+'\r');wait('Saved '+str(gpio_trace))
  gpio=json.loads(gpio_trace.read_text())
  assert gpio['model']['id']=='esp32c6-gpio'
  assert gpio['trace'][1]['registers']['gpio_out']==0x40000001
  assert gpio['trace'][2]['registers']['gpio_out']==179
  assert gpio['trace'][4]['signals']['selected_driver']==1
  assert gpio['trace'][10]['signals']['selected_driver']==0
  assert gpio['trace'][12]['signals']['selected_driver']=='Z'
  send('t');wait('Go to normalized tick')
  send('10\r');wait('tick 10/24')
  for _ in range(4):
   if 'format hex' in frame():break
   current=re.search(r'format (hex|decimal|binary|octal)',frame()).group(1)
   formats=['hex','decimal','binary','octal']
   expected=formats[(formats.index(current)+1)%4]
   send('F');wait('format '+expected)
  assert 'format hex' in frame(),frame()
  fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
  proc.send_signal(__import__('signal').SIGWINCH)
  send('\r');wait('STEP 10')
  assert 'Write 0x000C' in frame() and 'Write data: 0x00000003' in frame()
  send('F');wait('Write data: 3')
  send('$');wait('PDF page 271')
  send('s');wait('STEP SOURCE EVIDENCE')
  send('\r');wait('PDF page 271/1394')
  send('1');wait('Selected GPIO driver')
  send('\r');wait('STEP 10')
  send(']');wait('STEP 11')
  send('\x1b');wait('tick 11/24',absent='STEP 11')
  fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
  proc.send_signal(__import__('signal').SIGWINCH)
  send('d');wait('Import PDF')
  send(str(ROOT/'docs/references/ti-tca9534.pdf')+'\r');wait('Loaded TCA9534')
  send('c');wait('CREATE')
  send('jjjj\r');wait('REGISTER TABLE')
  send('j\r');wait('Register bank · simulation name')
  send('Reviewed command storage\r');wait('Register word width')
  send('\r');wait('Register rows')
  send('\r');wait('replace ?')
  send('Input_Port 0 ro 255 0; Output_Port 1 rw 255 255; Polarity_Inversion 2 rw 0 255; Configuration 3 rw 255 255\r');wait('Synthetic hardware set')
  send('before\r');wait('Evidence PDF page')
  send('\r');wait('Exact source excerpt')
  send('\r');wait('What the excerpt supports')
  send('\r');wait('Additional assumption')
  send('Storage only; GPIO and INT side effects omitted; input initialization is a high scenario.\r');wait('Added Reviewed command storage')
  reviewed=json.loads((Path(workspace)/'models'/'reviewed-command-storage.json').read_text())
  assert reviewed['registerMap'][1]['address']==1
  assert reviewed['evidence'][0]['page']==19
  assert reviewed['evidence'][0]['quote']=='Table 3. Command Byte Table'
  assert not any(pin['id']=='int_driver' for pin in reviewed['signals'])
  send('q');proc.wait(timeout=5)
  end=time.monotonic()+1
  while time.monotonic()<end and select.select([master],[],[],.05)[0]:
   try:captured+=os.read(master,65536).decode('utf8','replace')
   except OSError:break
  assert proc.returncode==0
  restored=termios.tcgetattr(slave)
  assert restored[3]&(termios.ICANON|termios.ECHO)==original[3]&(termios.ICANON|termios.ECHO)
  assert '\x1b[?25h' in captured and '\x1b[?1049l' in captured
  # An older workspace gains register geometry on demand after restarting.
  cache_path=next(path for path in (Path(workspace)/'documents').glob('*.json') if json.loads(path.read_text())['filename']=='ti-tca9534.pdf')
  cached=json.loads(cache_path.read_text())
  cached.pop('extractionVersion',None)
  cached.pop('analysis',None)
  for page in cached['pages']:page.pop('layoutLines',None)
  cache_path.write_text(json.dumps(cached))
  captured=''
  proc=subprocess.Popen([NODE,'scripts/chipsim.mjs','--workspace',workspace,'--model','reviewed-command-storage','--no-color'],cwd=ROOT,stdin=slave,stdout=slave,stderr=slave,close_fds=True)
  wait('Reviewed command storage')
  send('ll');wait('tick 2/')
  send('c');wait('CREATE')
  send('jjjj\r');wait('REGISTER TABLE')
  refreshed=json.loads(cache_path.read_text())
  assert refreshed['extractionVersion']==1
  assert refreshed['sha256']==cached['sha256']
  assert next(page for page in refreshed['pages'] if page['number']==19)['layoutLines']
  assert json.loads((Path(workspace)/'models'/'reviewed-command-storage.json').read_text())==reviewed
  send('\x1b');wait('tick 2/',absent='REGISTER TABLE')
  send('q');proc.wait(timeout=5)
  assert proc.returncode==0
  restored=termios.tcgetattr(slave)
  assert restored[3]&(termios.ICANON|termios.ECHO)==original[3]&(termios.ICANON|termios.ECHO)
  print('PTY verified: stepping, formats, register/log/stimulus views, scheduled event edits, undo/redo, exports, resize, sourced scenarios, custom behavior-table authoring/retry/revision/full-trace-review/restore, reviewed profiles, combinational/edge/level/tri-state tables, shared inputs, hierarchical decoder headers, Q0 retention and steady/transition clock lists, released outputs, addressed access, guided 32-bit register-bank authoring, extracted register-table review and unresolved-field rejection, old-workspace refresh after restart, direct pin editing, and terminal cleanup.')
 finally:
  if proc.poll() is None:proc.terminate();proc.wait(timeout=5)
  os.close(master);os.close(slave)

subprocess.run([__import__('sys').executable, str(ROOT/'scripts/test-agent-monitor-pty.py')], cwd=ROOT, check=True)
