ENTRY(_start)
MEMORY { ram (rwx) : ORIGIN = 0, LENGTH = 4096 }
SECTIONS {
  .text : { *(.text.start) *(.text*) *(.rodata*) } > ram
  .data : { *(.data*) } > ram
  .bss : { *(.bss*) *(COMMON) } > ram
}
