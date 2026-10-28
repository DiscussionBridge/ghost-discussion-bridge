// flock owns the process lifetime. EOF or a crashed parent releases the lock.
process.stdout.write("locked\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
