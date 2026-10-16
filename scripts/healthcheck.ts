/** Container-local readiness probe; never logs credentials or response bodies. */
try {
  const response=await fetch(`http://127.0.0.1:${process.env.PORT || '3000'}/ready`,{signal:AbortSignal.timeout(3500)});
  if(!response.ok) process.exitCode=1;
} catch {process.exitCode=1;}
