-- Original ChipSim example, CC0-1.0. One transfer increments the counter.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity transfer_counter is
  generic (FAULT : integer := 0);
  port (clk, reset, valid, ready : in std_logic;
        count : out unsigned(3 downto 0) := (others => '0');
        accept : out std_logic);
end;
architecture rtl of transfer_counter is
begin
  accept <= valid and ready;
  counter : process(clk)
  begin
    if rising_edge(clk) then
      if reset = '1' then count <= (others => '0');
      elsif accept = '1' then
        if FAULT = 0 then count <= count + 1; else count <= count + 2; end if;
      end if;
    end if;
  end process;
end;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity counter_tb is generic (FAULT : integer := 0); end;
architecture test of counter_tb is
  signal clk : std_logic := '0';
  signal reset : std_logic := '1';
  signal valid, ready : std_logic := '0';
  signal count : unsigned(3 downto 0);
  signal accept : std_logic;
  signal signed_probe : signed(7 downto 0) := to_signed(-3, 8);
  signal wide_probe : std_logic_vector(127 downto 0) := x"123456789abcdef0123456789abcdef0";
  signal logic_probe : std_logic_vector(0 to 8) := "UX01ZWLH-";
begin
  dut : entity work.transfer_counter generic map (FAULT => FAULT)
    port map (clk, reset, valid, ready, count, accept);
  clk <= not clk after 5 ns;
  passive_observer : process(clk)
  begin
    if clk = '1' and valid = '1' and ready = '1' then null; end if;
  end process;
  stimulus : process
    variable expected : integer := 0;
  begin
    wait for 1 ns;
    for cycle in 0 to 9 loop
      if cycle < 2 then reset <= '1'; else reset <= '0'; end if;
      if cycle mod 3 /= 0 then valid <= '1'; else valid <= '0'; end if;
      if cycle mod 4 /= 0 then ready <= '1'; else ready <= '0'; end if;
      wait for 5 ns;
      if reset = '1' then expected := 0;
      elsif valid = '1' and ready = '1' then expected := (expected + 1) mod 16; end if;
      assert to_integer(count) = expected report "transfer counter mismatch" severity failure;
      wait for 5 ns;
    end loop;
    std.env.finish;
  end process;
end;
