import cocotb
from cocotb.triggers import Timer

@cocotb.test()
async def reset_write_hold(dut):
    dut.clk.value = 0
    dut.rst_n.value = 0
    dut.valid.value = 0
    dut.write_en.value = 0
    dut.address.value = 0
    dut.write_data.value = 0

    async def cycle():
        dut.clk.value = 0
        await Timer(5, unit="ns")
        dut.clk.value = 1
        await Timer(5, unit="ns")

    await cycle()
    assert int(dut.word0.value) == 0
    assert int(dut.word1.value) == 0
    dut.rst_n.value = 1
    dut.valid.value = 1
    dut.write_en.value = 1
    dut.write_data.value = 0x1234
    await cycle()
    dut.address.value = 1
    dut.write_data.value = 0x1235
    await cycle()
    dut.valid.value = 0
    dut.write_data.value = 0xDEAD
    await cycle()
    assert int(dut.word0.value) == 0x1234
    assert int(dut.word1.value) == 0x1235
    assert int(dut.read_data.value) == 0x1235
