<?php

function greet($name)
{
    $unused = 42;
    $magic = 3.14159;
    return 'Hello, ' . $name . '!';
}

echo greet('world');
