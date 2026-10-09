-- SPDX-License-Identifier: CC0-1.0
-- ChipSim testbench for cocotb's unmodified CC0 adder.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.env.all;

entity adder_tb is end entity;
architecture test of adder_tb is
  signal A, B : unsigned(3 downto 0) := (others => '0');
  signal X : unsigned(4 downto 0);
  signal nand_a, nand_b, nand_probe : std_logic;
  signal clk : std_logic := '0';
  signal edges : unsigned(7 downto 0) := (others => '0');
  signal logic_probe : std_logic_vector(3 downto 0) := "10XZ";
begin
  dut : entity work.adder port map (A => A, B => B, X => X);
  nand_a <= A(0); nand_b <= B(0);
  nand_probe <= not (nand_a and nand_b);
  clk <= not clk after 2.5 ns;
  process(clk) begin
    if rising_edge(clk) then edges <= edges + 1; end if;
  end process;
  process begin
    for av in 0 to 15 loop
      for bv in 0 to 15 loop
        A <= to_unsigned(av, 4); B <= to_unsigned(bv, 4);
        wait for 1 ns;
        assert X = av + bv report "Adder mismatch" severity failure;
        wait for 4 ns;
      end loop;
    end loop;
    finish;
  end process;
end architecture;
