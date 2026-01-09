function createSnowflake() {
  
    const snowflake = document.createElement('div');

    snowflake.classList.add('snowflake');

    snowflake.style.left = Math.random() * 100 + 'vw';

    const size = Math.random() * 5 + 2 + 'px';
    snowflake.style.width = size;
    snowflake.style.height = size;


    snowflake.style.animationDuration = Math.random() * 3 + 2 + 's';

    snowflake.style.opacity = Math.random();

    document.body.appendChild(snowflake);


    setTimeout(() => {
        snowflake.remove();
    }, 5000);
}


setInterval(createSnowflake, 100);