"use strict";

/*	
REPO: https://github.com/andiy/espruino/wiki/Qespruino_SPI	

author: Q@meinort.at

	
INTERNAL
	qspi1.onerror=function(err){ ... };		// whenever an internal dma error occurs /w fallback implementation throwing Error(); this event should never occur during regular operation	
	
KNOWN ISSUES	
	i#1 end of transmission is not IRQ driven, but uses a workaround (setTimeout)
	i#2 QSPI.writeInterlaced( buffer, repeat_cnt) - hardware controlled repeats show some strange behaviour
	i#3 DMA clock is not turned off afterwards (to avoid conflicts with other modules using the DMA)
	i#4 require('Qespruino') inhere throws error; doing it at main.js is fine
	
*/

// const Q = require('Qespruino');	i#4

// function rclr(reg,mask){ poke32( reg, peek32(reg) & ~mask); }
var rclr=E.nativeCall(1, "void(int,int)", atob("AmiKQwJgcEc="));
/*
var rclr=E.asm("void(int,int)",
  "ldr r2,[r0]",
  "bic r2,r1",
  "str r2,[r0]",
  "bx lr"
); */

  
// global constants

const SPI_BASES = [0x40013000,0x40003800,0x40003C00,0x40013400]; //  SPI1+
const DMA_BASES = [0x40026000, 0x40026400];	// DMA1/2
const RCC_BASE   = 0x40023800;    

const RCC_AHB1ENR= RCC_BASE+0x30;  
const RCC_AHB1ENR_DMAx0 = [0x00200000,0x00400000];  // [..DMA1, ..DMA2]

const DMA_SxCR_EN   	= 0x00000001;  
const DMA_SxCR_MINC 	= 0x00000400;
const DMA_SxCR_MSIZE    = 0x00006000;
const DMA_SxCR_MSIZE_8  = 0x00000000;
const DMA_SxCR_MSIZE_16 = 0x00002000;
const DMA_SxCR_MSIZE_32 = 0x00004000;

const DMA_SxFCR_FTH  	= 0x00000003;
const DMA_SxFCR_FTH_1Q  = 0x00000000;
const DMA_SxFCR_FTH_2Q  = 0x00000001;
const DMA_SxFCR_FTH_3Q  = 0x00000002;
const DMA_SxFCR_FTH_FULL= 0x00000003;
const DMA_SxFCR_DMDIS	= 0x00000004;

const SPI_CR1_SPE 		= 0x0040;        
const SPI_CR2_TXDMAEN	= 0x0002;

const SPI_SR_TXE	= 0x0002;
const SPI_SR_BSY	= 0x0080;

/* dma_write( qctl:[10]u32, flat_buf_ptr:number, byte_cnt:number)	
		qctl ...
			[0]= &DMA_SxCR;
			[1]= &SPI_CR1;
			[2]= &DMA_zIFCR;
			[3]= DMA_zIFCR_anyIFx;
			[4]= cr;
			[5]= fcr;
			[6]= internal use only: byte_cnt;
			[7]= ---;
			[8]= internal use only: buf_ptr; 
			[9]= dma write pending flag 
		flat_buf_ptr ... must point to contents of flat buffer as returned by E.getAddressOf(mybuf,1)
		byte_cnt ... = flat_buf_bytes * repcnt
		result ... 0=ok, 1=DMA occupied, 2=byte count<1, 3=byte count > 0xffff, 4=flat_buf is not flat, 5=pending/xwait missing
 */
const DMA_WRITE_ERRORS= [null,'DMA occupied', 'byte count<1', 'byte count > 0xffff', 'flat_buf is not flat', 'pending/xwait missing']; 
const dma_write=E.nativeCall(1,'int(int,int,int)',atob('AWKCYUNqACsB0AUgcEeBaQEpAdoCIHBHT/b/c5lCAd0DIHBHA2oAKwHRBCBwR0JoEWhAI5lDEWACaBFoASMZQgPQACMTYAEgcEeCaMNoE2ACaANpE2BTaQchi0NBaQtDU2GBaVFgQ2gMM5NgA2rTYANpASELQxNgQmhRaAIjGUNRYBFoQCMZQxFgASNDYgAgcEc='));
/*
var dma_write=E.asm("int(int,int,int)",
    // r0=ctrl, r1=buf_ptr, r2=buf_len
    "str r1,[r0,#32]",  // qctl[8]= buf_ptr;
    "str r2,[r0,#24]",  // qctl[6]= buf_len
             
    // check input params
               
    "ldr r3,[r0,#36]",            // r3= qctl[9]= pending flag
    "cmp r3,#0",
    "beq pending_is_0",
    "  mov r0,#5",          // missing xwait - last call still pending
    "  bx lr",

"pending_is_0:",
                    
    "ldr r1,[r0,#24]",            // r1= qctl[6]= byte_cnt
    "cmp r1,#1",
    "bge bytes_ge_1",
    "  mov r0,#2",          // bytes <= 0
    "  bx lr",

"bytes_ge_1:",
              
    "movw r3,#65535",
    "cmp r1,r3",
    "ble bytes_le_0xffff",
    "  mov r0,#3",          // bytes >0xffff
    "  bx lr",
             
    "bytes_le_0xffff:",
              
    "ldr r3,[r0,#32]",            // r3= qctl[8]= buf_ptr;
    "cmp r3,#0",
    "bne buf_is_flat",
    "  mov r0,#4",          // flat buffer required
    "  bx lr",
              
"buf_is_flat:",
     
	// disable SPI for reprogramming
	// rclr16( SPI_CR1, SPI_CR1_SPE);  
	"ldr r2,[r0,#4]",	// r2= &SPI_CR1	
	"ldr r1,[r2]",		// r1= peek16(SPI_CR1)          ldrh???                          
    "mov r3,#64",       // SPI_CR1_SPE = 0x0040;
	"bic r1,r1,r3",		
	"str r1,[r2]",		// poke16(CPI_CR1, r1)          strh???

	// expect DMA stream to be already disabled
	// if (peek32( DMA_SxCR) & DMA_SxCR_EN) {
	// 	 poke32( DMA_SxCR, 0);    		// reset DMA in a fatalistic way
	//	 return 1;  }                   // throw Error('DMA not available');	
	"ldr r2,[r0,#0]",  // r2= &DMA_SxCR
	"ldr r1,[r2]",     // r1= peek32(DMA_SxCR)
    "mov r3,#1",
	"tst r1,r3",        // r1 & DMA_SxCR_EN

	"beq dma_disabled", // if !r1 -> dma_disabled
    "  mov r3,#0",         
	"  str r3,[r2]",   // poke32(DMA_SxCR,0)             
	"  mov r0,#1",     // return "dma not available"
	"  bx lr",
	
"dma_disabled:",

	// clear any pending IRQ flags
	"ldr r2,[r0,#8]",   // r2= qctl[2]= u.DMA_zIFCR;
	"ldr r3,[r0,#12]",  // r3= qctl[3]= u.DMA_zIFCR_anyIFx;
	"str r3,[r2]",

	// poke32( u.DMA_SxCR, cr);	
    "ldr r2,[r0,#0]",           // r2= qctl[0]= &DMA_SxCR 
    "ldr r3,[r0,#16]",          // r3= qctl[4]= cr;
    "str r3,[r2]", 

// r2= &DMA_SxCR from here on..
                    
    // peek32( DMA_SxFCR) &~(DMA_SxFCR_DMDIS|DMA_SxFCR_FTH)
    // DMA_SxFCR_FTH_xx= 0x00000003;
    // DMA_SxFCR_DMDIS = 0x00000004;
    "ldr r3,[r2,#20]",            // r1= &DMA_SxFCR = r2 + 0x14;
    "mov r1,#7",
    "bic r3,r3,r1",             
             
	// poke32( DMA_SxFCR, r3 | fcr);
    "ldr r1,[r0,#20]",            // r3= qctl[5]= fcr;
    "orr r3,r3,r1",
    "str r3,[r2,#20]",            // DMA_SxFCR = u.DMA_SxCR + 0x14;
                                              
	// set the total number of data items to be transferred 
    "ldr r1,[r0,#24]",            // r3= qctl[6]= byte_cnt
    "str r1,[r2,#4]",             // DMA_SxNDTR= u.DMA_SxCR + 0x04;
                    
	// set the peripheral port register address
    "ldr r3,[r0,#4]",            // r3= SPI_DR  = u.SPI_CR1 + 12;
    "add r3,#12",
    "str r3,[r2,#8]",            // DMA_SxPAR = u.DMA_SxCR + 0x08
             
	// set the memory address 
    "ldr r3,[r0,#32]",            // r3= qctl[8]= buf_ptr;
    "str r3,[r2,#12]",            // DMA_SxM0AR= u.DMA_SxCR + 0x0C
    
	// JFI: latest point to select spi slave (CS pin)
             
	//  enable the DMA SPI TX stream 
    "ldr r3,[r0,#16]",          // r3= qctl[4]= cr;
    "mov r1,#1",                 // DMA_SxCR_EN
    "orr r3,r3,r1",                
    "str r3,[r2]", 
             
	// enable the SPI Tx DMA request
	"ldr r2,[r0,#4]",	// r2= &SPI_CR1	
	"ldr r1,[r2,#4]",	// r1= peek16(SPI_CR2)     SPI_CR2 = u.SPI_CR1 + 4;  	     ldrh???                          
    "mov r3,#2",        // SPI_CR2_TXDMAEN
	"orr r1,r1,r3",		
	"str r1,[r2,#4]",	// poke16(SPI_CR2, r1)          strh???

    // start SPI
	"ldr r1,[r2]",		// r1= peek16(SPI_CR1)          ldrh???                          
    "mov r3,#64",       // SPI_CR1_SPE = 0x40
	"orr r1,r1,r3",		
	"str r1,[r2]",		// poke16(CPI_CR1, r1)          strh???

    // raise pending flag
    "mov r3,#1",               
    "str r3,[r0,#36]",            // qctl[9]= pending flag
               
	"mov r0,#0",    // return "ok"
	"bx lr");
*/

	
/*
 * SPIx: SPI1,SPI2,SPI3 instance
 */
const QSPI= function(SPIx){
	
	let spi_n0;	// *zero* based SPI number
	if      (SPIx === SPI1) spi_n0= 0;
	else if (SPIx === SPI2) spi_n0= 1;
	else if (SPIx === SPI3) spi_n0= 2;
	else throw Error('only SPI1/2/3 supported');

	this.spi= SPIx;
	this.spi_num= spi_n0+1;
	this.onerror= function(err){ throw Error('QSPI#'+this.spi_num+'.onerror #'+err);};
	//this.ms_per_byte = 8 * 1000 / opts.baud; ...see .setup
	
	// Set DMA2 Channel3 Stream3 as DMA SPI Tx stream
	const SPI_DMACFGS=[
		[2,3,3], // SPI1  DMA2 S3 C3 -or- DMA2 S5 C3
		[1,4,0], // SPI2  DMA1 S4 C0 
		[1,5,0], // SPI3  DMA1 S5 C0 -or- DMA1 S7 C0
		[2,1,4], // SPI4  DMA2 S1 C4 -or- DMA2 S4 C4 
		[2,4,2], // SPI5  DMA2 S4 C2 -or- DMA2 S6 C7
		[2,5,1]  // SPI6  DMA2 S5 C1     
	];

	const DMA_N   = SPI_DMACFGS[ spi_n0][0];    // 1,2
	const DMA_STRM= SPI_DMACFGS[ spi_n0][1];    // 0..7
	const DMA_CH_N= SPI_DMACFGS[ spi_n0][2];    // 0..7
	
	const DMA_BASE= DMA_BASES[DMA_N-1];
	const DMA_SxCR= DMA_BASE + 0x10 + 0x18*DMA_STRM; 	// &DMA_SxCR;	
	const SPI_CR1 = SPI_BASES[ spi_n0] + 0;  		// &SPI_CR1
	
	// setup ctrl
	// CIRC  DMA_Mode_Normal
	// PL    DMA_Priority_High
	// DIR   DMA_MemoryToPeripheral
	// PINC  DMA_PeripheralInc_Disable
	// PSIZE DMA_PeripheralDataSize_Byte
	// PBURST DMA_PeripheralBurst_Single
	// MBURST DMA_MemoryBurst_Single
	const DMA_SxCR_VAL	= 0x00020040 | 0x02000000*DMA_CH_N; // CHSEL ch#0 0x00000000, ch#1 0x02000000, ... ch#7 0x0E000000
	const u= this._qu= {		
		DMA_SxCR_VAL	: DMA_SxCR_VAL,
		DMA_SxCR_NOREP	: DMA_SxCR_VAL | DMA_SxCR_MINC | DMA_SxCR_MSIZE_8,
		DMA_zISR 		: DMA_BASE + (DMA_STRM < 4 ? 0 : 4),    // LISR HISR 
		DMA_zISR_TCIFx 	: [0x20, 0x20<<6, 0x20<<16, 0x20<<22][DMA_STRM & 3],
		DMA_zISR_anyIFx	: [0x2d, 0x2d<<6, 0x2d<<16, 0x2d<<22][DMA_STRM & 3]
	};

	const qc= E.newUint32Array(10);
	this._qctl= qc;	// assign qc to QSPIx to keep it available for asm function (lock-out garbage collection)
	this._qctl_ptr= E.getAddressOf(qc,1);

	
	qc[0]= DMA_SxCR; 
	qc[1]= SPI_CR1;
	qc[2]= u.DMA_zISR + 8;                  // &DMA_zIFCR	...LIFCR HIFCR 
	qc[3]= [0x3d, 0x3d<<6, 0x3d<<16, 0x3d<<22][DMA_STRM & 3]; // DMA_zIFCR_anyIFx	
	//qc[4]= u.DMA_SxCR_NOREP;	
	//qc[5]= 0;	 // DMA_SxFCR_DMDIS;	// clear DMDIS -> enable direct mode
	//qc[7]= 1;	 // repcnt
			
			
	poke32( RCC_AHB1ENR, peek32(RCC_AHB1ENR) | RCC_AHB1ENR_DMAx0[DMA_N-1]);		// enable peripheral clocks for DMA1/2
	
	/* RCC_APB2PeriphClockCmd( RCC_APB2Periph_SPI1, ENABLE);	already done by SPI.config or runtime environment
		+0x44  RCC->APB2ENR |= RCC_APB2Periph;	SPI1:0x00001000, SPI4:0x00002000
		+0x40  RCC->APB1ENR |= RCC_APB1Periph;  SPI2:0x00004000, SPI3:0x00008000 */	

	// reset any previous DMA activity to have a clean start
	const SPI_CR2 = SPI_CR1 + 4;  	
	const SPI_SR  = SPI_CR1 + 8;  	
	const SPI_DR  = SPI_CR1 + 12;  		
	
	poke32( DMA_SxCR, 0);    				  // disable/reset DMA stream
	while( peek32( DMA_SxCR) & DMA_SxCR_EN);  // wait until DMA stream stopped
	rclr( SPI_CR2, SPI_CR2_TXDMAEN);     	  // disable SPI Rx/Tx DMA request
	peek8( SPI_DR);							  // clear any pending OVR 
	peek16( SPI_SR);		
};

QSPI.prototype.setup= function(opts){	
	this.ms_per_byte = 8 * 1000 / opts.baud;
	this.spi.setup(opts);
};

QSPI.prototype.error= function(err){

	if (this.onerror) this.onerror( err);
		
	if (this._await_cb) this._await_cb( err);
	this._await_cb= null;	// fired!
	return;
};

	
/* limited hi-performace call of writeInterlaced	
 */ 	
QSPI.prototype.writeInterlaced$= function( flat_buf_ptr, flat_buf_bytes) {
	
	const qc= this._qctl;
	
	qc[4]= this._qu.DMA_SxCR_NOREP;	
	qc[5]= 0;	 //  clear DMA_SxFCR_DMDIS -> enable direct mode	which is slightly faster than fifo mode
	
	if (qc[9]) this._await_now();
		
	const err= dma_write( this._qctl_ptr, flat_buf_ptr, flat_buf_bytes);	
	if (err) this.error('write error#'+DMA_WRITE_ERRORS[err]);	// inform caller that something went wrong
};


/* 
 *
 * flat_buf: - must be a flat var 'cause of DMA 
 *		!!! must be reserved for EXCLUSIVE ACCESS by writeInterlaced until return from next .awaitInterlaced 
 *			(which is called implicitly by any .writeInterlaced oder .legacy) !!!
 *		
 * repcnt: optional (default=1); repeat flat_buf N times; large counts are splittet into chunks of 64k
 *		!!!repcnt>1 combines with flat_buf.length of 1/2/4 byte only!!!
 */ 	
QSPI.prototype.writeInterlaced= function( flat_buf, repcnt){
	const buf_ptr  = E.getAddressOf( flat_buf,1); 	// data is already a flat var..? 				-> see data parameter		
	const buf_bytes= flat_buf.length;
		
	repcnt= repcnt||1;
	
	if (repcnt<=1) {
		this.writeInterlaced$( buf_ptr, buf_bytes);
	}
	else {
		let cr= this._qu.DMA_SxCR_VAL; 

		switch(buf_bytes){
			case 1:	cr|= DMA_SxCR_MSIZE_8; break;
			case 2:	cr|= DMA_SxCR_MSIZE_16; break;
			case 4:	cr|= DMA_SxCR_MSIZE_32; break;
			default: throw Error( 'repeat requires a buffer with 1/2/4 byte length');
		} 		
		
		const qc= this._qctl;
		qc[4]= cr;		
		qc[5]= DMA_SxFCR_DMDIS | 3; // set  DMDIS -> enable fifo; FH = FULL -> this is compatible with any flat_buf.length
		
		const MAX_CNT= 0xfffc;	// full multiple of 4

		for(let cnt= repcnt*buf_bytes; cnt>0; cnt-=MAX_CNT) {	// divide into chunks of <64k bytes
			if (qc[9]) this._await_now();		
			const err= dma_write( this._qctl_ptr, buf_ptr, Math.min( MAX_CNT,cnt));	
			if (err) this.error('write error#'+DMA_WRITE_ERRORS[err]);	
		}	
		// i#2
		// -- send a single fucking dummy pixel at the end to get output to the screen
		// this seems to fix some bug which cuts-off the last DMA tx command.... but why!???
		this._await_now();				
		const err= dma_write( this._qctl_ptr, buf_ptr, buf_bytes);	
		if (err) this.error('write error#'+DMA_WRITE_ERRORS[err]);	// inform caller that something went wrong
	}	
};

/*
 * cb: 
 *		function() ... asnyc call; cb is called as soon as recent writeInterlaced done - even in case of any error!
 *							!!! cb may be called immediately and/or on next tick !!!
 * 		none ... synchronous call; function blocks until recent writeInterlaced ready
 *
 * #onerror fires ahead of cb in case of any error
 */
QSPI.prototype.awaitInterlaced= function(cb){

	// use async version of awaitInterlaced
	if (cb) {

		if (this._await_cb) this.error('awaitInterlaced callback override');
		this._await_cb= cb;
		const bytes= peek32( this._qctl[0] + 0x04);	// read unsent bytes from DMA_SxNDTR = qc.DMA_SxCR + 4;
				
		if (bytes < 10) {					// fire cb immediately if DMA (almost) ready
			this._await_now();
		}
		else {								// otherwise..
			// wait long enough to be sure that recent writeInterlaced is at least close to done, and then test again
			// > this is just a workaround instead of hooking the TX IRQ <
			const ms= bytes * this.ms_per_byte;
			this._await_tmr=setTimeout( this._await_now.bind(this,1), ms);		// i#1
		}
	}
	
	// use sync version of awaitInterlaced
	else {
		if (this._qctl[9]) this._await_now();
	}	
};


/*	!!!never call this when no writeInterlaced pending!!!
	
	_qctl:
		[0]= u.DMA_SxCR;
		[1]= u.SPI_CR1;
		[2]= u.DMA_zIFCR;
		[3]= u.DMA_zIFCR_anyIFx;
*/
QSPI.prototype._await_now= function(await_tmr_expired){

	if (!await_tmr_expired && this._await_tmr) clearTimeout( this._await_tmr);
	this._await_tmr= null;			
		
	const u= this._qu;		
	const qc= this._qctl;
	
	if (!qc[9]) {								// pending		
		this.error( 'no interlace pending');
		return;
	}
	
	qc[9]= 0;	// clear pending	
	
	const DMA_SxCR  = qc[0];	// i#2 this line distorbs the DMA transmission in fifo mode --- why!!???
	const DMA_SxFCR = DMA_SxCR + 0x14;
	
	const SPI_CR1 = qc[1];  
	const SPI_CR2 = SPI_CR1 + 4;  	
	const SPI_SR  = SPI_CR1 + 8;  	
	const SPI_DR  = SPI_CR1 + 12;  		
	// wait for end of data transfer 
	// #5 TCIFx ok
	// #3 TEIFx transfer error
	// #2 DMEIFx direct mode error
	// #0 FEIFx fifo error
	let err;
	while (!(err= (peek32(u.DMA_zISR)& u.DMA_zISR_anyIFx)));
	err &= ~u.DMA_zISR_TCIFx;	
	while(!(peek16( SPI_SR) & SPI_SR_TXE));	// wait for TXE=1, then
	while(  peek16( SPI_SR) & SPI_SR_BSY);	// wait for BSY=0

	// JFI: earliest point where to disable a CS 
	
	poke32( DMA_SxCR, 0);    				 // disable DMA stream
	while( peek32( DMA_SxCR) & DMA_SxCR_EN);  // wait until DMA stream stopped
	rclr( SPI_CR2, SPI_CR2_TXDMAEN);     	// disable SPI Rx/Tx DMA request
	
	peek8( SPI_DR);							// OVR has been set because of missing RX DMA - clear it!
	peek16( SPI_SR);

	// rclr( SPI_CR1, SPI_CR1_SPE);        ... do not disable SPI -> for normal SPI.write operations!
	// rclr( RCC_AHB1ENR, RCC_AHB1ENR_DMAx0[DMA_N-1]);	... i#3 do not disable peripheral clocks for DMAx
		
	if (err) this.error( 'DMA fault 0x'+err.toString(16));	// if any error flag set...
	else if (this._await_cb) {
		this._await_cb(null);								// fire async writeInterlaced done ok callback
		this._await_cb= null;
	}
};


exports = QSPI;
