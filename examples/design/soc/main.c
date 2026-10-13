#include <stdint.h>
void main(void) {
    volatile uint32_t *words = (volatile uint32_t *)0x10000000;
    words[0] = 0x1234;
    words[1] = words[0] + 1;
    __asm__ volatile("ebreak");
    for (;;) {}
}
