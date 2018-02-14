
//
// grant flat arraybuffer  http://forum.espruino.com/conversations/316409/#comment14077573
if (E.newArrayBuffer===undefined) E.newArrayBuffer= function(bytes){

	const mem= E.toString({data:0,count:bytes}); // undefined -> failed to alloc the *flat* string   
	if (!mem) throw Error('alloc flat for '+bytes+' bytes FAILED!');  
	return E.toArrayBuffer(mem);
};

if (E.newUint8Array===undefined) E.newUint8Array= function(cnt){
  return new Uint8Array( E.newArrayBuffer(cnt));
};

if (E.newUint16Array===undefined) E.newUint16Array= function(cnt){
  return new Uint16Array( E.newArrayBuffer(cnt*2));
};

if (E.newUint32Array===undefined) E.newUint32Array= function(cnt){
  return new Uint32Array( E.newArrayBuffer(cnt*4));
};


exports.newUint32Array = function(cnt){
  return new Uint32Array( E.newArrayBuffer(cnt*4));
};
