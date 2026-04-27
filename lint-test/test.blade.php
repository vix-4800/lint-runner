<x-layout>
    <div class="wrapper" >
        @if($user)
        <span>{{ $user->name }}</span>
        @else
            <span>guest</span>
        @endif
    </div>
</x-layout>
